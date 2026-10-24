/**
 * Admission (§3.2b) — the gate a generated test passes through before it is
 * stored, counted or shown to a human.
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 *
 * Before this existed, a generated test was written to the database, counted
 * towards coverage and rendered in the cockpit with *nothing checked*:
 *
 *   - A missing brace became "Playwright produced no report" at run time,
 *     hours later, with no line number. Nothing in the repo parsed generated
 *     code.
 *   - `findWeakAssertions` already knew how to spot a zero-assertion test, but
 *     it ran only as a retrospective suite report — so the test was stored and
 *     closed a coverage gap at birth, and the finding arrived after the number
 *     had already been believed.
 *   - Nothing compared the code against the plan item it was generated FOR.
 *     A test written for a different scenario than the one a human approved
 *     was indistinguishable from a correct one.
 *   - The prompt ranks role/label locators above CSS, and nothing verified it,
 *     so a file of `div.sc-x7f2 > span:nth-child(3)` was stored clean.
 *   - The no-sleep and no-lock-in rules were enforced on the generator only —
 *     inline-edit and heal-apply, which also produce code, skipped them.
 *
 * So: ONE gate, ONE verdict, and every finding attributable to a line a human
 * can look at. Every code-producing path (generator, inline-edit, heal-apply)
 * runs through `admit`.
 *
 * THE RULES THIS FILE LIVES BY
 *
 *  1. **It is pure.** No child process, no filesystem, no network, no model
 *     call. The four gates that need a toolchain (syntax, typecheck, format,
 *     lint) are INJECTED through `ToolchainGates`. That is not architectural
 *     fastidiousness: it is what lets the whole table below be tested in
 *     milliseconds, with no API key, which is the only way a verdict table
 *     this consequential stays correct.
 *
 *  2. **UNAVAILABLE is not PASS.** A gate that could not run says so, and that
 *     survives into `reviewFlags`. "Admitted" must never silently mean
 *     "unchecked" — that is the original defect wearing a new hat.
 *
 *  3. **Absence of evidence is not evidence.** `resolveDialect` returns null
 *     when it cannot tell what language a file is; null means "I cannot read
 *     this test", never "this test asserts nothing". A pytest file accused of
 *     having no assertions is one obviously wrong finding, and one is enough
 *     for a customer to stop trusting the page.
 *
 *  4. **A refused test covers nothing at all.** Refusal is reserved for things
 *     re-prompting cannot fix (you already have this test) and for a second
 *     failed attempt at the things it can. A brittle locator is worth a human's
 *     eye, not a bin.
 *
 *  5. **Honesty over coverage.** Every number here is a threshold somebody
 *     chose; each one is stated as a named constant with the reasoning next to
 *     it, so the next person can disagree with the number rather than guess at
 *     the intent.
 */

import { FRAMEWORKS_BY_LANGUAGE } from '@qaai/shared';
import type { DialectId, Language, PlanItem, Priority, TestType, UiFramework } from '@qaai/shared';
import {
  assertionExampleFor,
  blankStringsAndComments,
  countAssertions,
  dialect,
  findAssertions,
  findTestBlocks,
  resolveDialect,
} from '@qaai/shared';
import {
  FIXED_SLEEP_PATTERNS,
  findsFixedSleep,
  isEcosystemId,
  resolveEcosystem,
  testFilePath,
} from './ecosystem-prompts.js';
import type { Ecosystem } from './ecosystem-prompts.js';
import { generationStrategyFor } from './spec-strategies.js';
import type { ToolchainGates } from './toolchain.js';
import {
  PLUGIN_ASSERTED_TYPES,
  extractBehavior,
  findDuplicates,
  findWeakAssertions,
  specAssertions,
} from './suite-health.js';
import type { Severity, SuiteHealthTestInput, WeakAssertion } from './suite-health.js';

// ─── The contract ────────────────────────────────────────────────────────────

export type GateId =
  | 'SYNTAX'
  | 'TYPECHECK'
  | 'FORMAT'
  | 'LINT'
  | 'ASSERTIONS'
  | 'LOCATORS'
  | 'FIDELITY'
  | 'NO_LOCK_IN'
  | 'NO_FIXED_SLEEP'
  | 'PATH_CONVENTION'
  | 'DUPLICATE'
  | 'MUTATION';

/** UNAVAILABLE is not PASS. It means the gate could not run, and it must survive into the report. */
export type GateStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNAVAILABLE';

export interface GateOutcome {
  gate: GateId;
  status: GateStatus;
  /** One sentence a human can act on. */
  why: string;
  /** Specifics: the offending lines, the missing assertions, the brittle locators. */
  detail: string[];
  /** 1-based line in `code`, when there is one line to blame. */
  line: number | null;
}

export type AdmissionVerdict = 'ADMIT' | 'ADMIT_WITH_FLAGS' | 'REVISE' | 'REFUSE';

export interface AdmissionReport {
  verdict: AdmissionVerdict;
  gates: GateOutcome[];
  /** Appended to the test's reviewFlags. Human-readable, no jargon. */
  reviewFlags: string[];
  /** When the verdict is REVISE: exactly what the model must fix, quoting the offending lines. Null otherwise. */
  revisePrompt: string | null;
  /** The code as admitted — a FORMAT gate may have rewritten it. */
  code: string;
  /**
   * ADDITIVE to the agreed contract, and the one deviation in this file.
   *
   * PATH_CONVENTION's whole job is to replace a path the runner cannot collect
   * (a green suite over a file nobody executed). The agreed report shape
   * carries `code` but no path, so without this field the gate could only
   * complain and the caller would have no corrected value to store — a
   * decorative gate. Non-null only when the path was wrong AND a conventional
   * replacement could be computed; callers that ignore it get exactly the
   * old `generator.ts` behaviour, so adding it breaks nothing.
   *
   * The same string is always `detail[0]` of the PATH_CONVENTION outcome, for
   * a caller coding against the original shape.
   */
  correctedFilePath: string | null;
}

/*
 * `ToolchainGates` is declared by its IMPLEMENTER, `toolchain.ts`, and imported
 * here type-only. Both files wrote the interface independently and the shapes
 * agreed, which is luck, not a guarantee — and two declarations of an injection
 * contract is how an injected gate starts returning a field the caller stopped
 * reading. The split: this file owns the gate VOCABULARY (it reasons about
 * verdicts); toolchain.ts owns the gate IMPLEMENTATION contract, because its
 * documentation is about prettier and tsc and belongs next to the code that
 * runs them. Type-only in both directions, so the cycle exists only for the
 * type checker.
 */
export type { GateInput, ToolchainGates } from './toolchain.js';

export interface AdmissionInput {
  code: string;
  filePath: string;
  testType: TestType;
  /** The plan item this test is supposed to implement; null for an edit or heal. */
  item: PlanItem | null;
  /** For resolving the assertion dialect. */
  language?: Language | null;
  ecosystemId?: string | null;
  /** The spec for spec-driven and hybrid test types; the assertions may live here rather than in code. */
  spec?: unknown;
  /** Which attempt this is. 1 = first. A failure that is revisable on attempt 1 is a refusal on attempt 2. */
  attempt?: number;
  /** Existing tests to check for duplication; omit to skip the DUPLICATE gate (it reports UNAVAILABLE). */
  existing?: readonly {
    id: string;
    name: string;
    filePath: string;
    code: string | null;
    spec?: unknown;
    type: TestType;
  }[];
  /** Injected; when absent, SYNTAX/TYPECHECK/FORMAT/LINT each report UNAVAILABLE — never PASS. */
  toolchain?: ToolchainGates;

  /**
   * The mutation gate, injected — proving a test fails when the behaviour it
   * covers breaks means RUNNING it against a mutated build, which this pure
   * function cannot do. `mutationGate` in `mutation-gate.ts` is the logic; the
   * worker supplies the execution capability and hands the result in here.
   *
   * When absent, admission reports MUTATION as UNAVAILABLE and — uniquely —
   * does NOT put that in `reviewFlags`, because a gate that can never run in
   * this configuration would otherwise flag every test ever admitted. When it
   * IS supplied and comes back UNAVAILABLE, that is a fact about THIS test (no
   * source identified, an unsupported language, a trial that timed out) and it
   * is flagged like every other unavailable gate. Suppressing it in both cases
   * is the version of this that lies.
   */
  mutation?: () => Promise<GateOutcome>;

  /**
   * False when nothing can act on a rewrite request: a deterministic scaffold
   * (no model involved at all), or a schema-constrained artefact whose shape
   * forbids the prose a rewrite would have to add.
   *
   * REVISE for such an artefact is a verdict nobody can satisfy — the caller
   * either loops forever or silently treats it as a refusal. So the arithmetic
   * collapses: a hard failure becomes REFUSE at once (it was never going to
   * get better, and refusing is the point — an unparseable or assertion-less
   * artefact that the product GENERATED is a bug in our own template, and it
   * should be loud), while a soft failure becomes ADMIT_WITH_FLAGS (a brittle
   * selector in a scaffold is worth a human's eye, not an empty suite).
   *
   * Defaults to true, which is the generated-by-a-model case.
   */
  revisable?: boolean;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/*
 * Every number this module decides anything on, in one place, with the
 * reasoning. A reader who disagrees should be able to disagree with a number.
 */

/**
 * LOCATORS: the share of a test's locators that may be brittle before the test
 * is sent back to the model rather than merely flagged for a human.
 *
 * ONE THIRD. The reasoning is about what each kind of mistake costs:
 *
 *   - One brittle locator among nine good ones is usually a real element the
 *     crawl never captured, and the model said so in a review flag. Sending
 *     that back wastes a strong-tier call and will probably come back the same,
 *     because there genuinely is no role-based way to reach that element.
 *   - A third or more brittle means the model stopped using the locators it was
 *     handed and started reading the DOM dump. That file breaks on the next
 *     refactor regardless of whether the behaviour it tests still works, and a
 *     test that fails for reasons unrelated to the product is how a suite
 *     becomes noise. It is worth one more attempt.
 *
 * A test with exactly one locator and that locator brittle lands at 1.0 and
 * fails, which is correct: that locator IS the test.
 */
export const BRITTLE_LOCATOR_FAIL_RATIO = 1 / 3;

/**
 * LOCATORS: how many simple selectors may be chained before the chain itself is
 * the brittleness. THREE.
 *
 * `main .cart .row` is three and is a legitimate scoping idiom. The fourth step
 * is where a selector stops describing an element and starts describing a DOM
 * shape — every wrapper div anyone inserts above it breaks the test, and
 * wrapper divs get inserted for reasons that have nothing to do with the
 * behaviour under test.
 */
export const LOCATOR_CHAIN_MAX_STEPS = 3;

/**
 * LOCATORS: how many utility-looking classes make a chain a styling chain. TWO.
 *
 * One `.flex` could be a semantic class in somebody's hand-written CSS. Two in
 * the same selector (`.flex.items-center`) is a styling framework, and styling
 * classes are the least stable thing in a codebase: they change when a designer
 * adjusts padding, which is precisely when a test must NOT break.
 */
export const TAILWIND_CHAIN_MIN = 2;

/**
 * FIDELITY: the share of an approved assertion's meaningful words that must
 * appear somewhere in the code before we call that assertion implemented. HALF.
 *
 * A plan assertion is an English sentence — "the order confirmation shows a
 * total of $42.00". After stopwords it is {order, confirmation, shows, total,
 * 42, 00}; the code that implements it faithfully says
 * `expect(page.getByText('Order confirmed')).toBeVisible()` and
 * `expect(total).toHaveText('$42.00')`, which matches order, total, 42 and 00
 * but not "confirmation" (the code says "confirmed") or "shows". That is 4 of 6
 * — and it is a CORRECT implementation.
 *
 * So the floor cannot be high. Half is the level at which "the test is about
 * this" is still distinguishable from "the test is about something else": a
 * test generated for a different scenario shares only the feature noun, which
 * is one token out of five or six. The crude stemmer below exists for the same
 * reason — it buys back the inflections ("confirmation"/"confirmed") that would
 * otherwise force the floor down to a level that measures nothing.
 *
 * Deliberately NOT a proof of fidelity. Token overlap cannot tell `toBe(200)`
 * from `toBe(500)`. It catches the failure it was built for — wholesale plan
 * drift, where the file implements a different scenario — and claims nothing
 * more.
 */
export const FIDELITY_TOKEN_FLOOR = 0.5;

/**
 * FIDELITY: fewer meaningful words than this and the assertion cannot be
 * measured at all. TWO.
 *
 * "It works" tokenises to {works}. A one-token overlap test is a coin flip, and
 * reporting a coin flip as a missing assertion would blame the code for a vague
 * plan. Such assertions are reported as UNMEASURABLE instead, by name, so the
 * human sees which approved assertions nobody checked.
 */
export const FIDELITY_MIN_TOKENS = 2;

/** Detail lists are evidence, not a code listing. Past this they stop being read. */
const MAX_DETAIL = 20;

/**
 * DUPLICATE: a generous reporting cap, NOT a similarity threshold.
 *
 * `findDuplicates` sorts its pairs by score and slices; with the default 100 a
 * candidate's own pair could be crowded out by existing-vs-existing pairs in a
 * large suite, and a dropped pair reads as "not a duplicate". The similarity
 * threshold itself stays at the repo's `DEFAULT_MIN_SIMILARITY` on purpose —
 * there is exactly one notion of similarity in this codebase and it is not
 * this file's.
 */
const DUPLICATE_MAX_REPORTED_PAIRS = 5_000;

/** The id the candidate is compared under; it has no database row yet. */
const CANDIDATE_ID = '__admission_candidate__';

// ─── Outcome constructors ────────────────────────────────────────────────────

function pass(gate: GateId, why: string, detail: string[] = []): GateOutcome {
  return { gate, status: 'PASS', why, detail, line: null };
}

function warn(gate: GateId, why: string, detail: string[] = [], line: number | null = null): GateOutcome {
  return { gate, status: 'WARN', why, detail: capped(detail), line };
}

function fail(gate: GateId, why: string, detail: string[] = [], line: number | null = null): GateOutcome {
  return { gate, status: 'FAIL', why, detail: capped(detail), line };
}

function unavailable(gate: GateId, why: string, detail: string[] = []): GateOutcome {
  return { gate, status: 'UNAVAILABLE', why, detail: capped(detail), line: null };
}

/**
 * `detail` with an honest "and N more" rather than a silent truncation — and
 * idempotent, so a caller that already capped a sub-list and then prepended a
 * summary line cannot lose the "and N more" to a second trim.
 */
function capped(items: string[]): string[] {
  if (items.length <= MAX_DETAIL) return items;
  return [...items.slice(0, MAX_DETAIL - 1), `…and ${items.length - (MAX_DETAIL - 1)} more`];
}

// ─── Reading code without a parser ───────────────────────────────────────────

/**
 * Comments blanked, STRING CONTENTS KEPT.
 *
 * Locator values and expected values live INSIDE string literals, so blanking
 * them would hide exactly the evidence LOCATORS and FIDELITY read. Comments
 * must still go, and for the opposite reason — `// assert the total is $42`
 * would otherwise let a model satisfy FIDELITY with prose while asserting
 * nothing, which is the defect rather than the fix.
 *
 * `null` means no dialect could be resolved, and an unreadable file is left
 * exactly as it came in: guessing at its comment syntax would blank code.
 */
function stripCommentsKeepStrings(code: string, id: DialectId | null): string {
  if (!id) return code;
  return blankStringsAndComments(code, id, { keepStrings: true });
}

interface StringLiteral {
  value: string;
  line: number;
}

/**
 * Every string literal in the file, with its line. Quote characters come from
 * the dialect where one is known, and fall back to the three JavaScript quotes
 * otherwise — a selector is a selector in any language, and a file we cannot
 * identify is still worth ranking locators in.
 */
function stringLiterals(code: string, id: DialectId | null): StringLiteral[] {
  const quotes = id ? dialect(id).quotes : ['"', "'", '`'];
  if (quotes.length === 0) return [];
  const out: StringLiteral[] = [];
  const n = code.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const ch = code[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    const quote = quotes.find((q) => q === ch);
    if (!quote) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let value = '';
    while (j < n) {
      if (code[j] === '\\') {
        value += code[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (code[j] === quote) break;
      if (code[j] === '\n' && quote !== '`') break;
      value += code[j];
      j += 1;
    }
    if (code[j] === quote) {
      out.push({ value, line });
      line += value.split('\n').length - 1;
      i = j + 1;
    } else {
      i = j;
    }
  }

  return out;
}

// ─── Gate: ASSERTIONS ────────────────────────────────────────────────────────

/**
 * Does this test check anything?
 *
 * The one question that decides whether storing the test is honest, asked
 * BEFORE the coverage number moves rather than in a report afterwards. Three
 * sources, in this order, because each is right about a case the others get
 * wrong:
 *
 *   1. The test TYPE. An accessibility or visual test asserts in the runner.
 *      Accusing it of having no assertions is how the whole page loses trust.
 *   2. The SPEC, for spec-driven types. The assertions of an API test are
 *      `expectStatus` and `bodyMatches` keys, and its `code` is an inert
 *      pointer comment — reading the code would find nothing and be wrong.
 *   3. The CODE, in its own dialect. `countAssertions` from the dialect spine
 *      is the authority on "are there any", in all sixteen dialects.
 *
 * Only once the code is known to assert SOMETHING does `findWeakAssertions`
 * get a say on whether what it asserts is worth anything — and only for the
 * dialect its own lexicon was written against, because that function and
 * `extractBehavior` behind it speak `expect(` and Playwright.
 */
function assertionsGate(args: {
  code: string;
  filePath: string;
  testType: TestType;
  spec: unknown;
  dialectId: DialectId | null;
  item: PlanItem | null;
}): GateOutcome {
  const { code, filePath, testType, spec, dialectId, item } = args;

  if (PLUGIN_ASSERTED_TYPES.has(testType)) {
    return pass(
      'ASSERTIONS',
      `A ${testType} test does not author assertions — its runner plugin is the thing that passes or fails it, so there is nothing in this file to count.`,
    );
  }

  const declared = specAssertions(spec);
  const strategy = generationStrategyFor(testType);

  if (strategy.mode === 'spec') {
    if (declared.count === 0) {
      return fail(
        'ASSERTIONS',
        `This ${testType} test is driven by its spec, and that spec declares nothing to check — the runner would execute it and have no criterion to pass or fail on.`,
        ['The spec contains no status, expectation, schema, threshold or match key.'],
      );
    }
    if (declared.statusOnly) {
      return fail(
        'ASSERTIONS',
        'The spec checks a status code and nothing about the response body, so a handler returning 200 with an empty object passes this test.',
        [declared.statusQuote ?? '(the spec declares only a status check)'],
      );
    }
    return pass(
      'ASSERTIONS',
      `The spec declares ${declared.count} thing(s) to check, including at least one about content rather than transport.`,
    );
  }

  if (!dialectId) {
    const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '(no extension)';
    return unavailable(
      'ASSERTIONS',
      `Nobody has confirmed this test asserts anything: no assertion dialect is known for a "${ext}" file, and guessing "it asserts nothing" from a file we cannot read is the mistake this gate exists to avoid.`,
      [`filePath: ${filePath}`],
    );
  }

  const count = countAssertions(code, dialectId);
  const blocks = findTestBlocks(code, dialectId);
  const anchor = blocks[0]?.line ?? null;

  if (count === 0) {
    // A hybrid type can legitimately carry its criterion in the spec.
    if (declared.count > 0 && !declared.statusOnly) {
      return pass(
        'ASSERTIONS',
        `The code asserts nothing directly, but this type's spec declares ${declared.count} thing(s) to check, which is where a ${testType} test's criterion belongs.`,
      );
    }
    if (declared.statusOnly) {
      return fail(
        'ASSERTIONS',
        'Nothing in the code asserts anything and the spec checks only a status code, so this test passes against a response with the wrong body.',
        [declared.statusQuote ?? '(the spec declares only a status check)'],
        anchor,
      );
    }
    return fail(
      'ASSERTIONS',
      `This test makes no assertion anywhere. It passes as long as nothing throws, which means it reports green on a page that rendered an error, an empty list, or a spinner that never resolved — and it closes a coverage gap while doing it.`,
      [
        `No ${dialect(dialectId).label} assertion found in ${code.split('\n').length} line(s).`,
        `This dialect writes them like: ${assertionExampleFor(dialectId)}`,
      ],
      anchor,
    );
  }

  /*
   * Past here the test DOES assert. Whether what it asserts is worth anything
   * is a much harder question, and `findWeakAssertions` only answers it for
   * JavaScript: `extractBehavior` behind it scans for `expect(`, `.goto(` and
   * `.click(`, which is the JS_EXPECT lexicon and nothing else. Running it on a
   * pytest file would report NO_ASSERTIONS at HIGH severity on a correct test —
   * the precise false finding `dialect.ts` was written to end.
   *
   * So for the other fifteen dialects this gate stops at the honest answer it
   * has ("there are N assertions") and says in `detail` what was not checked.
   * It does not report UNAVAILABLE: the gate's own question was answered, and a
   * permanent UNAVAILABLE on every non-JavaScript test would put a review flag
   * on every non-JavaScript test, which is a flag nobody reads.
   */
  const assertionLines = findAssertions(code, dialectId);
  if (dialectId !== 'JS_EXPECT') {
    return pass(
      'ASSERTIONS',
      `This test makes ${count} ${dialect(dialectId).label} assertion(s).`,
      [
        `Assertion(s) on line(s) ${assertionLines.map((h) => h.line).join(', ')}.`,
        `Not checked: whether those assertions are strong. The weak-assertion analysis (existence-only, transport-only, volatile expected values, assertions swallowed by a catch) is written against JavaScript's \`expect(\` and does not read ${dialect(dialectId).label}.`,
      ],
    );
  }

  const shTest = toSuiteHealthTest({ id: CANDIDATE_ID, code, filePath, testType, spec, item });
  const behavior = extractBehavior(shTest);
  const findings = findWeakAssertions([shTest], new Map([[shTest.id, behavior]])).filter(
    (f) =>
      /*
       * Two kinds are dropped on purpose.
       *
       * NO_ASSERTIONS: the dialect spine already found `count` assertions above.
       * `extractBehavior` only recognises `expect(`, so a file asserting with
       * `assert.strictEqual(` (which IS the JS_EXPECT lexicon) would come back
       * accused of asserting nothing. The dialect count wins.
       *
       * NO_NEGATIVE_PATH: a suite-level judgement about a FEATURE — "nothing
       * anywhere covers the error path". Admission sees one test. Of course the
       * one happy-path test a human just approved has no negative path; that is
       * what they approved. Reporting it here would flag every test forever.
       */
      f.kind !== 'NO_ASSERTIONS' && f.kind !== 'NO_NEGATIVE_PATH',
  );

  /*
   * Severity is the FAIL/WARN line, not a hand-picked list of kinds.
   *
   * The two HIGH kinds that matter most are NO_ASSERTIONS and TRANSPORT_ONLY;
   * suite health rates SWALLOWED_ASSERTION HIGH as well, and it deserves it —
   * an assertion inside a `try` whose `catch` neither re-throws nor fails IS no
   * assertion, with the added insult of looking like one. Keying on severity
   * rather than a kind list also means a new HIGH kind added to suite health is
   * a FAIL here on the day it lands, instead of being silently downgraded to a
   * WARN by a list nobody remembered to update.
   */
  const high = findings.filter((f) => f.severity === ('HIGH' satisfies Severity));
  if (high.length > 0) {
    const first = high[0]!;
    return fail('ASSERTIONS', first.why, capped(findings.map(describeWeakness)), first.line);
  }
  if (findings.length > 0) {
    const first = findings[0]!;
    return warn('ASSERTIONS', first.why, capped(findings.map(describeWeakness)), first.line);
  }

  return pass('ASSERTIONS', `This test makes ${count} assertion(s), none of them weak.`, [
    `Assertion(s) on line(s) ${assertionLines.map((h) => h.line).join(', ')}.`,
  ]);
}

function describeWeakness(finding: WeakAssertion): string {
  const where = finding.line === null ? '' : `line ${finding.line}: `;
  return `${finding.kind} (${finding.severity}) — ${where}${finding.quote} — ${finding.assertInstead}`;
}

// ─── Gate: LOCATORS ──────────────────────────────────────────────────────────

/**
 * Role + accessible name, then label, then visible text, then an explicit test
 * id — that is `UNIVERSAL_RULES`' order of preference, stated to the model on
 * every generation and, until this gate, verified nowhere. A file of
 * `div.sc-x7f2 > span:nth-child(3)` was stored clean.
 *
 * What makes a locator brittle is not ugliness, it is COUPLING TO SOMETHING
 * THAT IS NOT THE BEHAVIOUR: a build-time class hash, a position among
 * siblings, a DOM depth, a framework-generated id. Each of those changes for
 * reasons unrelated to whether the feature works, and a test that fails for
 * reasons unrelated to the product is how a suite becomes noise.
 */
type BrittleReason =
  | 'GENERATED_CLASS'
  | 'STYLING_CHAIN'
  | 'POSITIONAL'
  | 'LONG_CHAIN'
  | 'ABSOLUTE_XPATH'
  | 'GENERATED_ID'
  | 'STRUCTURE_ONLY';

const BRITTLE_EXPLANATION: Record<BrittleReason, string> = {
  GENERATED_CLASS:
    'the class name is generated at build time (styled-components, emotion, CSS modules) and changes on the next build',
  STYLING_CHAIN:
    'these are styling utility classes, which change when a designer adjusts padding — not when the behaviour changes',
  POSITIONAL:
    'it selects by position among siblings, so inserting or reordering one element breaks it',
  LONG_CHAIN: `it depends on ${LOCATOR_CHAIN_MAX_STEPS + 1}+ levels of DOM shape, so any wrapper element anyone adds above it breaks it`,
  ABSOLUTE_XPATH:
    'an absolute XPath encodes the whole document structure and breaks on any change above the target',
  GENERATED_ID: 'the id is generated at render time (React useId, Radix, MUI) and differs per run',
  STRUCTURE_ONLY:
    'its only identity is an element name, so it matches whichever one happens to come first',
};

/** CSS-in-JS and CSS-modules class hashes: `.sc-x7f2`, `.css-1a2b3c`, `.Button__a1b2c`. */
const GENERATED_CLASS_PATTERNS: readonly RegExp[] = [
  /\.(?:sc|css|emotion|styled|jss|svelte|makeStyles|useStyles)-[A-Za-z0-9]{3,}/,
  // CSS modules: `Button_root__1a2b3` — a `__` suffix of 5+ chars containing a digit.
  /\.[A-Za-z][\w-]*__(?=[A-Za-z0-9]{5,})(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+/,
  // A bare hash token: 6+ chars, no separators, at least two digits.
  /\.(?=[A-Za-z0-9]{6,}(?![\w-]))(?=(?:[A-Za-z]*\d){2})[A-Za-z0-9]+(?![\w-])/,
];

/** Render-time ids: React's `:r3:`, Radix, MUI, Ember, a UUID, a 4-digit counter. */
const GENERATED_ID_PATTERNS: readonly RegExp[] = [
  /#\\?:[A-Za-z0-9]+\\?:/,
  /#(?:mui-|headlessui-|radix-|react-aria-|ember|ext-gen|downshift-|rc_select_)[\w:-]*\d/i,
  /#[\w-]*[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /#[A-Za-z_][\w-]*\d{4,}(?![\w-])/,
];

const POSITIONAL_PATTERN =
  /:nth-(?:child|of-type|last-child|last-of-type)\b|:(?:first|last|only)-(?:child|of-type)\b|\[\s*\d+\s*\]/;

const TAILWIND_VARIANT =
  /^(?:sm|md|lg|xl|2xl|hover|focus|focus-visible|focus-within|active|disabled|visited|dark|group-hover|group-focus|peer-focus|first|last|odd|even|print|motion-safe|motion-reduce|rtl|ltr):/;

/**
 * Utility-class HEADS, not a Tailwind dictionary. A full list would be obsolete
 * on the next minor release and is not needed: the question is only "do these
 * classes describe styling rather than identity", and a head plus a value
 * (`px-4`, `text-sm`, `w-full`) answers it.
 */
const UTILITY_HEADS = new Set([
  'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe',
  'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me',
  'w', 'h', 'min', 'max', 'size', 'text', 'bg', 'border', 'rounded',
  'gap', 'space', 'flex', 'grid', 'items', 'justify', 'content', 'self', 'place',
  'font', 'leading', 'tracking', 'whitespace', 'break', 'decoration',
  'shadow', 'opacity', 'z', 'top', 'left', 'right', 'bottom', 'inset',
  'col', 'row', 'order', 'overflow', 'overscroll', 'cursor', 'select',
  'transition', 'duration', 'delay', 'ease', 'translate', 'rotate', 'scale', 'skew',
  'divide', 'ring', 'outline', 'fill', 'stroke', 'aspect', 'object',
  'basis', 'grow', 'shrink', 'animate', 'backdrop', 'blur', 'from', 'via', 'to',
]);

/**
 * …and utility VALUES. The head alone is not enough: Tailwind's `order-1` and a
 * hand-written `order-summary` share the head `order`, and calling the second
 * one a styling class would accuse a perfectly good semantic selector. A
 * utility class is a head plus a SCALE — a number, a fraction, a t-shirt size,
 * a named position, or a bracketed arbitrary value — and `summary` is none of
 * those.
 */
const UTILITY_VALUE =
  /^(?:\d+(?:\.\d+)?|\d+\/\d+|\[[^\]]*\]|px|full|auto|screen|none|fit|min|max|dvh|svh|lvh|xs|sm|base|md|lg|xl|[2-9]xl|center|start|end|between|around|evenly|baseline|stretch|first|last|normal|bold|semibold|medium|light|thin|extrabold|black|white|transparent|current|inherit|solid|dashed|dotted|double|hidden|wide|wider|widest|tight|tighter|snug|relaxed|loose|nowrap|pre|wrap|reverse|col|row|col-reverse|row-reverse|initial|x|y|t|b|l|r|s|e|[a-z]+-\d{2,3}|[a-z]{1,2}-(?:\d+(?:\.\d+)?|full|auto|screen|px|none|\[[^\]]*\]))$/;

const UTILITY_BARE = new Set([
  'flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'hidden',
  'absolute', 'relative', 'fixed', 'sticky', 'static', 'container', 'truncate',
  'italic', 'uppercase', 'lowercase', 'capitalize', 'underline', 'antialiased',
  'sr-only', 'invisible', 'visible', 'isolate', 'contents',
]);

function looksLikeUtilityClass(token: string): boolean {
  let t = token;
  while (TAILWIND_VARIANT.test(t)) t = t.replace(TAILWIND_VARIANT, '');
  if (UTILITY_BARE.has(t)) return true;
  const bare = t.replace(/^-/, '');
  const dash = bare.indexOf('-');
  if (dash < 1) return false;
  return UTILITY_HEADS.has(bare.slice(0, dash)) && UTILITY_VALUE.test(bare.slice(dash + 1));
}

/** Attribute selectors that name a thing rather than describe a shape. */
const RESILIENT_ATTRIBUTE =
  /\[\s*(?:data-test(?:id)?|data-cy|data-qa|data-testid|aria-label|aria-labelledby|role|name|placeholder|title|alt|for|type|value|href)\b/i;

/**
 * The locator APIs that ARE the preference order — in every casing the fourteen
 * ecosystems write them in (`getByRole`, `get_by_role`, `GetByRole`,
 * `findByRole`), plus the idiomatic equivalents in the ecosystems that have no
 * role engine at all (Capybara's `click_button`, Selenium's `By.linkText`,
 * Cypress's `cy.contains`, TestCafe's `withText`).
 */
const RESILIENT_LOCATOR_CALL =
  /\b(?:(?:get|find|query)_?(?:all_?)?by_?(?:role|label|label_?text|text|test_?id|placeholder|alt_?text|title|display_?value)|By\s*\.\s*(?:name|linkText|partialLinkText|link_text|partial_link_text)|find_(?:button|link|field)|click_(?:button|link|on)|fill_in|have_(?:button|link|field|content|text|selector)|assert_(?:selector|text|button|link|field)|with(?:Exact)?Text|cy\s*\.\s*contains)/gi;

/** An HTML element name — enough of them that a structure-only selector is caught. */
const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col',
  'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl',
  'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu',
  'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p',
  'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script',
  'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

/**
 * Is this string literal a selector at all?
 *
 * Deliberately conservative: a false positive here accuses a piece of test DATA
 * of being a brittle locator, which is the kind of obviously-wrong finding that
 * costs the whole report its credibility. So a candidate must be built only out
 * of selector syntax — no prose punctuation, no spaces that are not
 * combinators — and must carry at least one structural marker.
 */
function looksLikeSelector(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 300) return false;
  if (value.includes('\n')) return false;

  // Robot Framework / WebdriverIO prefixed strategies.
  const prefixed = /^(?:css|xpath)\s*[=:]\s*(.+)$/i.exec(value);
  if (prefixed) return looksLikeSelector(prefixed[1]!);

  /*
   * XPath. A SINGLE-step path is excluded on purpose: `/checkout` is a route,
   * `/html` is an XPath, and nothing in the string tells them apart. Routes are
   * everywhere in these tests and XPaths with one step are vanishingly rare, so
   * an XPath must earn it — a `//` prefix, a predicate, an `@attribute`, or two
   * or more steps.
   */
  if (/^\(?\/{1,2}[A-Za-z*@[(]/.test(value)) {
    if (/^\(?\/\//.test(value)) return true;
    if (/[[@]/.test(value)) return true;
    return value.replace(/^\(?\/+/, '').split('/').filter((s) => s.length > 0).length >= 2;
  }

  if (!/^[A-Za-z*#.[:]/.test(value)) return false;
  // Any character that only shows up in prose disqualifies it outright.
  if (/[!?;{}%&`\\]/.test(value)) return false;
  if (/\s{2,}/.test(value)) return false;

  const steps = value.split(/\s*[>+~]\s*|\s+/).filter((s) => s.length > 0);
  if (steps.length === 0) return false;
  const simple = /^[A-Za-z*][\w-]*(?:[.#][\w\\:-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)*$|^(?:[.#][\w\\:-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)+$/;
  if (!steps.every((step) => simple.test(step))) return false;

  if (/[.#[:]/.test(value)) return true;

  /*
   * A chain of bare element names (`div > span`) is a selector. A SINGLE bare
   * element name is not treated as one, because `'button'` is far more likely
   * to be the ARIA role in `getByRole('button', …)` than a CSS selector, and
   * reporting a role name as a brittle CSS locator is exactly the kind of
   * obviously-wrong finding that costs a report its credibility. The cost is
   * that `locator('button')` goes unflagged; the alternative cost was flagging
   * every correct role locator in the product.
   */
  return steps.length >= 2 && steps.every((step) => HTML_ELEMENTS.has(step.toLowerCase()));
}

function classifySelector(raw: string): BrittleReason[] {
  const prefixed = /^(?:css|xpath)\s*[=:]\s*(.+)$/i.exec(raw.trim());
  const value = (prefixed ? prefixed[1]! : raw).trim();
  const reasons: BrittleReason[] = [];
  const isXPath = /^\(?\/{1,2}/.test(value);

  if (isXPath) {
    // `/html/body/…` and `//html/body/…` are both rooted at the document: the
    // `//` makes no difference once the first step is `html` or `body`.
    if (/^\(?\/(?!\/)/.test(value) || /^\(?\/\/(?:html|body)\b/i.test(value)) {
      reasons.push('ABSOLUTE_XPATH');
    }
    if (POSITIONAL_PATTERN.test(value)) reasons.push('POSITIONAL');
    const steps = value.split('/').filter((s) => s.length > 0);
    if (steps.length > LOCATOR_CHAIN_MAX_STEPS) reasons.push('LONG_CHAIN');
    // `//*[@data-testid="x"]` is a perfectly resilient XPath; nothing above fires.
    if (reasons.length === 0 && !/@(?:data-test|data-testid|data-cy|aria-label|id|name|role)/i.test(value)) {
      reasons.push('STRUCTURE_ONLY');
    }
    return reasons;
  }

  if (GENERATED_CLASS_PATTERNS.some((p) => p.test(value))) reasons.push('GENERATED_CLASS');
  if (GENERATED_ID_PATTERNS.some((p) => p.test(value))) reasons.push('GENERATED_ID');
  if (POSITIONAL_PATTERN.test(value)) reasons.push('POSITIONAL');

  const steps = value.split(/\s*[>+~]\s*|\s+/).filter((s) => s.length > 0);
  if (steps.length > LOCATOR_CHAIN_MAX_STEPS) reasons.push('LONG_CHAIN');

  const classes = [...value.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
  if (classes.filter(looksLikeUtilityClass).length >= TAILWIND_CHAIN_MIN) {
    reasons.push('STYLING_CHAIN');
  }

  if (
    reasons.length === 0 &&
    !/[.#[]/.test(value) &&
    steps.every((step) => HTML_ELEMENTS.has(step.toLowerCase()))
  ) {
    reasons.push('STRUCTURE_ONLY');
  }

  /*
   * An attribute that NAMES the element rescues a complaint about the
   * element's SHAPE.
   *
   * `div.sc-x7f2[data-testid="order-total"]` has a generated class in it and is
   * not brittle: the test id pins the element, and the class is along for the
   * ride. Reporting it would be the gate crying wolf about the one attribute
   * every framework's own docs tell people to add — and a gate that flags good
   * practice gets switched off, after which it protects nothing.
   *
   * POSITIONAL and ABSOLUTE_XPATH deliberately survive, because they are not
   * complaints about shape: `[data-testid="row"]:nth-child(3)` names a KIND of
   * element and then picks the third one, and which one is third is exactly
   * what a reorder changes.
   */
  if (RESILIENT_ATTRIBUTE.test(value)) {
    const stillFragile = reasons.filter(
      (reason) => reason === 'POSITIONAL' || reason === 'ABSOLUTE_XPATH',
    );
    return stillFragile;
  }

  return reasons;
}

function locatorsGate(args: { code: string; dialectId: DialectId | null }): GateOutcome {
  const source = stripCommentsKeepStrings(args.code, args.dialectId);
  const lines = source.split('\n');

  // Counted per OCCURRENCE, not per line: a line with two role locators has
  // two, and counting it once would tilt the brittle ratio upwards on exactly
  // the well-written files that chain them.
  let resilient = 0;
  for (const line of lines) {
    if (line === undefined) continue;
    resilient += [...line.matchAll(RESILIENT_LOCATOR_CALL)].length;
  }

  const selectors = stringLiterals(source, args.dialectId).filter((s) => looksLikeSelector(s.value));
  const brittle: Array<{ line: number; value: string; reasons: BrittleReason[] }> = [];
  let resilientSelectors = 0;
  for (const selector of selectors) {
    const reasons = classifySelector(selector.value);
    if (reasons.length > 0) brittle.push({ line: selector.line, value: selector.value, reasons });
    else resilientSelectors += 1;
  }

  const total = resilient + selectors.length;

  /*
   * No locators at all is a PASS, not a FAIL. An API test selects nothing on a
   * page; a unit test selects nothing at all; a contract test reads a schema.
   * Failing them for having no locators would refuse whole test types for
   * being the test type the human approved.
   */
  if (total === 0) {
    return pass(
      'LOCATORS',
      'This test addresses no page elements — an API, unit, contract or CLI test selects nothing — so there is no locator resilience to rank.',
    );
  }

  const detail = capped(
    brittle.map(
      (b) =>
        `line ${b.line}: ${b.value} — ${b.reasons.map((r) => BRITTLE_EXPLANATION[r]).join('; ')}`,
    ),
  );
  const summary = `${brittle.length} of ${total} locator(s) are brittle (${resilient} role/label/text/test-id call(s), ${resilientSelectors} resilient selector string(s)).`;

  if (brittle.length === 0) {
    return pass('LOCATORS', `All ${total} locator(s) address elements by role, label, text or test id.`, [
      summary,
    ]);
  }

  const ratio = brittle.length / total;
  const first = brittle[0]!;
  if (ratio > BRITTLE_LOCATOR_FAIL_RATIO) {
    return fail(
      'LOCATORS',
      `${brittle.length} of this test's ${total} locator(s) are coupled to things that are not the behaviour — generated class names, sibling position or DOM depth — so this test will break on a refactor that changes nothing a user can see.`,
      [summary, ...detail],
      first.line,
    );
  }
  return warn(
    'LOCATORS',
    `${brittle.length} of this test's ${total} locator(s) reach their element by structure rather than by role, label or test id, and will break if that structure changes.`,
    [summary, ...detail],
    first.line,
  );
}

// ─── Gate: FIDELITY ──────────────────────────────────────────────────────────

/**
 * Does this code implement the plan item a human APPROVED?
 *
 * The quietest of the failures and the most expensive. Everything else is
 * visible once somebody opens the file: a missing assertion, a nasty selector,
 * a sleep. Plan drift is invisible — the test looks fine, passes, and covers a
 * scenario nobody asked for, while the coverage number says the approved one is
 * done. Nothing in the repo compared the two before this.
 *
 * The method is token overlap with a stated floor, which is weak on purpose:
 * it cannot tell `toBe(200)` from `toBe(500)` and does not claim to. It catches
 * the wholesale case — the file is about a different scenario — and reports
 * every plan assertion it could not find, by name, so a human reads the gap
 * rather than a score.
 */
const FIDELITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'are', 'be', 'was',
  'were', 'that', 'this', 'it', 'its', 'for', 'with', 'from', 'by', 'as', 'not', 'no',
  'should', 'shows', 'show', 'shown', 'see', 'sees', 'seen', 'user', 'users', 'page',
  'pages', 'then', 'when', 'given', 'after', 'before', 'their', 'there', 'has', 'have',
  'had', 'does', 'did', 'can', 'will', 'would', 'must', 'may', 'also', 'into', 'out',
  'over', 'under', 'again', 'only', 'just', 'any', 'all', 'each', 'both', 'than', 'but',
  'they', 'them', 'you', 'our', 'test', 'tests', 'click', 'clicks', 'clicking', 'verify',
  'verifies', 'check', 'checks', 'assert', 'asserts', 'ensure', 'ensures', 'display',
  'displays', 'displayed', 'appear', 'appears', 'correct', 'correctly', 'valid', 'new',
]);

/**
 * Words, from English prose or from code, in a form the two can be compared in.
 *
 * Camel case is split first (`toHaveText` → to have text, `OrderConfirmation` →
 * order confirmation), because that is where the plan's nouns live in code.
 * Numbers survive at two characters — "42", "200", "404" are among the most
 * meaningful tokens a plan assertion has.
 */
function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => (/^\d+$/.test(t) ? t.length >= 2 : t.length >= 3))
    .filter((t) => !FIDELITY_STOPWORDS.has(t));
}

/**
 * A crude stemmer, and crude is the point.
 *
 * "confirmation" in the plan and "confirmed" in the code are the same fact, and
 * a comparison that misses it forces the overlap floor down to a level that
 * measures nothing. Porter stemming would be better and would also be a
 * dependency and a behaviour nobody here can predict by eye. These five
 * suffixes buy most of the inflections an English assertion sentence has.
 */
function variantsOf(token: string): string[] {
  const out = new Set<string>([token]);
  const strip = (suffix: string, replacement = ''): void => {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      out.add(token.slice(0, -suffix.length) + replacement);
    }
  };
  out.add(`${token}s`);
  strip('s');
  strip('es');
  strip('ies', 'y');
  strip('ing');
  strip('ed');
  strip('ation', 'e');
  strip('ation');
  strip('ment');
  return [...out];
}

function tokenOverlap(phrase: string, haystack: Set<string>): { matched: string[]; missing: string[] } {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const token of new Set(tokensOf(phrase))) {
    if (variantsOf(token).some((v) => haystack.has(v))) matched.push(token);
    else missing.push(token);
  }
  return { matched, missing };
}

/**
 * Paths that look like routes, out of free text or out of a serialised spec.
 *
 * This is the only part of a plan item that a SPEC can be held to: a spec's
 * fields are a schema, and `{ path, fullPage, viewport, maxDiffRatio }` has
 * nowhere for "the order confirmation shows a total of $42.00" to live.
 */
function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\/[A-Za-z0-9_\-./:{}[\]*]{1,120}/g)) {
    const raw = match[0].replace(/[.,;:)\]"']+$/, '');
    // A lone slash, a protocol's `//`, and a decimal like `/2.5` are not routes.
    if (raw.length < 2 || raw.startsWith('//')) continue;
    found.add(raw.toLowerCase());
  }
  return [...found];
}

/** `/orders/42` and `/orders/:id` are the same route; `/orders` is its parent. */
function samePathish(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .split('/')
      .filter(Boolean)
      .map((seg) => (/^(?:\d+|:.+|\{.+\}|\[.+\]|\*)$/.test(seg) ? '*' : seg));
  const x = norm(a);
  const y = norm(b);
  const shared = Math.min(x.length, y.length);
  if (shared === 0) return false;
  for (let i = 0; i < shared; i += 1) {
    if (x[i] === y[i] || x[i] === '*' || y[i] === '*') continue;
    return false;
  }
  return true;
}

/**
 * FIDELITY for the spec-driven types (VISUAL, ACCESSIBILITY, LOAD,
 * PERFORMANCE, SECURITY_SMOKE, API).
 *
 * Measured, not assumed: running the ordinary token-overlap trace over
 * `JSON.stringify(spec)` for every scaffoldable type FAILED five of six, and
 * for the correct spec every time — because the overlap it needs is English,
 * and these specs are thresholds, viewports and route arrays. Wiring that up
 * would have refused every VISUAL, ACCESSIBILITY, LOAD and PERFORMANCE test
 * after paying for two strong-tier calls, and refused the deterministic
 * scaffolds outright on a deployment with no model key at all.
 *
 * So: what IS measurable is measured, and what is not is named.
 *   - The plan names a route and the spec targets an unrelated one: provable
 *     plan drift, and it FAILS. That is the case worth catching — a test
 *     generated against a different page than the one approved.
 *   - The paths agree: UNAVAILABLE, saying what was checked and what was not.
 *     Reporting PASS here would claim the assertions were traced; they cannot
 *     be, and this file's rule is that an unmeasurable thing is named.
 *   - Either side names no path: UNAVAILABLE, same reason.
 */
function specFidelityGate(item: PlanItem, spec: unknown): GateOutcome {
  const planText = `${item.title} ${item.steps.join(' ')} ${item.assertions.join(' ')}`;
  const planPaths = pathsIn(planText);
  const specPaths = pathsIn(spec === undefined || spec === null ? '' : JSON.stringify(spec));

  const unmeasured = `Whether this spec asserts what the plan item asked for could not be checked: its schema has no field prose can live in, so there is nothing to trace "${item.assertions[0] ?? item.title}" into. Only the target can be compared.`;

  if (planPaths.length === 0 || specPaths.length === 0) {
    return unavailable('FIDELITY', unmeasured, [
      planPaths.length === 0
        ? 'The plan item names no route, so even the target could not be compared.'
        : 'The spec names no route, so even the target could not be compared.',
    ]);
  }

  const shared = planPaths.filter((planPath) =>
    specPaths.some((specPath) => samePathish(specPath, planPath)),
  );

  if (shared.length === 0) {
    return fail(
      'FIDELITY',
      `This spec targets ${specPaths.slice(0, 3).join(', ')}, and the approved plan item is about ${planPaths.slice(0, 3).join(', ')} — it was generated against a different part of the application than the one that was approved.`,
      [
        `Plan item: ${item.title}`,
        `Routes named in the plan: ${planPaths.join(', ')}`,
        `Routes targeted by the spec: ${specPaths.join(', ')}`,
      ],
    );
  }

  return unavailable('FIDELITY', unmeasured, [
    `Checked: the spec targets ${shared.join(', ')}, which the plan item names.`,
    'Not checked: whether it asserts what the plan asked for.',
  ]);
}

function fidelityGate(args: {
  code: string;
  spec: unknown;
  item: PlanItem | null;
  testType: TestType;
  dialectId: DialectId | null;
}): GateOutcome {
  const { code, spec, item, testType, dialectId } = args;

  if (!item) {
    return unavailable(
      'FIDELITY',
      'There is no approved plan item to trace this code against — an inline edit or a heal changes an existing test, so nothing here can say whether it still matches what was approved.',
    );
  }
  /*
   * A spec-driven type has no code to trace — `code` is a pointer comment and
   * the artefact is the spec. Its fidelity is a different measurement, and
   * pretending otherwise is what failed five of six scaffoldable types.
   */
  if (generationStrategyFor(testType).mode === 'spec') {
    return specFidelityGate(item, spec);
  }

  if (!dialectId) {
    return unavailable(
      'FIDELITY',
      'Whether this code implements the approved plan could not be checked: the file is in no dialect this repo can read, and a token-overlap guess over an unknown language would be a number with no meaning behind it.',
      [`Plan item: ${item.title}`],
    );
  }

  // Comments are blanked and string contents kept: a model must not be able to
  // satisfy fidelity with `// asserts the total is $42` and no assertion.
  const source = stripCommentsKeepStrings(code, dialectId);
  const specText = spec === undefined || spec === null ? '' : JSON.stringify(spec);
  const haystack = new Set(tokensOf(`${source}\n${specText}`));

  const missingAssertions: string[] = [];
  const unmeasurable: string[] = [];
  const traced: string[] = [];

  for (const assertion of item.assertions) {
    const tokens = new Set(tokensOf(assertion));
    if (tokens.size < FIDELITY_MIN_TOKENS) {
      unmeasurable.push(assertion);
      continue;
    }
    const { matched, missing } = tokenOverlap(assertion, haystack);
    const score = matched.length / tokens.size;
    if (score < FIDELITY_TOKEN_FLOOR) {
      missingAssertions.push(
        `Plan assertion not implemented: "${assertion}" — only ${matched.length} of ${tokens.size} meaningful word(s) appear in the file${
          missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''
        }.`,
      );
    } else {
      traced.push(assertion);
    }
  }

  const missingSteps: string[] = [];
  for (const step of item.steps) {
    const tokens = new Set(tokensOf(step));
    if (tokens.size < FIDELITY_MIN_TOKENS) continue;
    const { matched, missing } = tokenOverlap(step, haystack);
    if (matched.length / tokens.size < FIDELITY_TOKEN_FLOOR) {
      missingSteps.push(
        `Plan step not implemented: "${step}" — missing: ${missing.join(', ') || '(no word matched)'}.`,
      );
    }
  }

  const summary = `${traced.length} of ${item.assertions.length} approved assertion(s) and ${
    item.steps.length - missingSteps.length
  } of ${item.steps.length} approved step(s) are traceable into this file.`;
  const unmeasurableDetail = unmeasurable.map(
    (a) =>
      `Plan assertion too vague to trace: "${a}" — it has fewer than ${FIDELITY_MIN_TOKENS} meaningful words, so nobody has confirmed this one is implemented.`,
  );

  if (missingAssertions.length > 0) {
    return fail(
      'FIDELITY',
      `This code does not implement ${missingAssertions.length} of the ${item.assertions.length} assertion(s) a human approved on "${item.title}", so storing it would close that coverage gap over a test that checks something else.`,
      capped([summary, ...missingAssertions, ...missingSteps, ...unmeasurableDetail]),
    );
  }
  if (missingSteps.length > 0 || unmeasurable.length > 0) {
    return warn(
      'FIDELITY',
      missingSteps.length > 0
        ? `Every approved assertion is traceable into this file, but ${missingSteps.length} of the ${item.steps.length} approved step(s) are not — the test may reach the same assertion by a different route than the one that was reviewed.`
        : `Every approved assertion that could be measured is traceable, but ${unmeasurable.length} of them are worded too vaguely to trace at all.`,
      capped([summary, ...missingSteps, ...unmeasurableDetail]),
    );
  }
  return pass(
    'FIDELITY',
    `Every assertion and step on the approved plan item "${item.title}" is traceable into this file.`,
    [summary],
  );
}

// ─── Gate: NO_LOCK_IN ────────────────────────────────────────────────────────

/**
 * The generated test is the CUSTOMER'S code. It lives in their repository, it
 * is reviewed by their engineers, and it has to run under their own command
 * with QAAI uninstalled. A `@qaai/` import is therefore not a style problem: it
 * is a file that does not run where it is going to live.
 *
 * The distinction this gate draws, which a bare regex cannot: an import or a
 * bare identifier is a DEPENDENCY and fails; the same word inside a string
 * literal is test DATA — a URL, a fixture name, an expected page title — and
 * only warrants a look. A test of QAAI's own cockpit legitimately navigates to
 * a URL with "qaai" in it, and refusing it would be this gate misfiring on the
 * one product it was written for.
 */
/**
 * Lines that bring a module in. A scoped `@qaai/` package is unmistakable, but
 * `import "github.com/qaai/helpers"` and `from qaai.helpers import login` are
 * dependencies too, and the Go form lives inside a string literal — so the
 * import CONTEXT has to be read, not just the position of the word.
 */
const IMPORT_LINE =
  /^\s*(?:@?[Ii]mport\b|from\s|using\s|use\s|package\s|load\s|#include\b|require(?:_relative)?\b|include_once\b)|\b(?:require|import)\s*\(/;

function noLockInGate(args: { code: string; dialectId: DialectId | null }): GateOutcome {
  const { code, dialectId } = args;
  const withoutComments = stripCommentsKeepStrings(code, dialectId);
  // Strings blanked as well: a mention that survives this is an identifier, so
  // it is a dependency rather than a piece of test data.
  const codeOnly = dialectId
    ? blankStringsAndComments(withoutComments, dialectId)
    : withoutComments;

  const lines = withoutComments.split('\n');
  const blankedLines = codeOnly.split('\n');

  const dependency: string[] = [];
  const mention: string[] = [];
  let dependencyLine: number | null = null;
  let mentionLine: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !/qaai/i.test(line)) continue;
    const isDependency =
      /@qaai\//i.test(line) ||
      IMPORT_LINE.test(line) ||
      /qaai/i.test(blankedLines[i] ?? '');
    if (isDependency) {
      dependency.push(`line ${i + 1}: ${line.trim()}`);
      if (dependencyLine === null) dependencyLine = i + 1;
    } else {
      mention.push(`line ${i + 1}: ${line.trim()}`);
      if (mentionLine === null) mentionLine = i + 1;
    }
  }

  if (dependency.length > 0) {
    return fail(
      'NO_LOCK_IN',
      "This file depends on QAAI, so it cannot run in the customer's repository under their own test command — the generated test is their code and has to stand alone.",
      capped([...dependency, ...mention]),
      dependencyLine,
    );
  }
  if (mention.length > 0) {
    // A piece of test DATA, not a dependency: a URL, an expected page title, a
    // fixture name. A test of QAAI's own cockpit legitimately has these, and
    // refusing it would be this gate misfiring on the one product it exists for.
    return warn(
      'NO_LOCK_IN',
      "QAAI is named in a string in this file — most likely a URL or a piece of test data rather than a dependency, but worth a glance before this lands in the customer's repository.",
      capped(mention),
      mentionLine,
    );
  }
  return pass(
    'NO_LOCK_IN',
    "This file references nothing from QAAI, so it runs in the customer's repository with QAAI uninstalled.",
  );
}

// ─── Gate: NO_FIXED_SLEEP ────────────────────────────────────────────────────

/**
 * A fixed sleep is both the slowest possible wait and the least reliable one:
 * it is always too long on a fast machine and always too short on the day it
 * matters. The rule is in `UNIVERSAL_RULES`, the detector is
 * `FIXED_SLEEP_PATTERNS` in `ecosystem-prompts.ts`, and until now only the
 * generator ran it — inline-edit and heal-apply, which also produce code,
 * did not, and a heal is exactly where a model reaches for a sleep.
 *
 * WARN, not FAIL, which matches what `generator.ts` already does: a fixed sleep
 * is a flake source in a test that is otherwise about the right thing, so it is
 * worth a human's eye rather than a refusal and a second strong-tier call.
 */
function noFixedSleepGate(args: { code: string; dialectId: DialectId | null }): GateOutcome {
  const source = stripCommentsKeepStrings(args.code, args.dialectId);
  if (!findsFixedSleep(source)) {
    return pass(
      'NO_FIXED_SLEEP',
      'This test waits for conditions rather than for the clock, so it is neither slower than it needs to be nor flaky when the machine is busy.',
    );
  }

  const detail: string[] = [];
  let firstLine: number | null = null;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const hit = FIXED_SLEEP_PATTERNS.find((pattern) => pattern.test(line));
    if (!hit) continue;
    detail.push(`line ${i + 1}: ${line.trim()}`);
    if (firstLine === null) firstLine = i + 1;
  }

  return warn(
    'NO_FIXED_SLEEP',
    'This test sleeps for a fixed duration, which is the slowest possible wait and the one most likely to fail on a busy machine — wait for the element state or the response instead.',
    capped(detail),
    firstLine,
  );
}

// ─── Gate: PATH_CONVENTION ───────────────────────────────────────────────────

/**
 * A path the runner cannot collect is worse than a wrong path: the suite goes
 * GREEN over a file nobody executed. A Go test not named `*_test.go` does not
 * compile as a test; a pytest file not named `test_*.py` is not collected; a
 * Java class whose name does not match its file does not build. None of those
 * produce an error — they produce a pass over nothing, and a coverage number
 * that counts it.
 *
 * The convention is mechanical, so the computed path wins over the model's and
 * we say so, exactly as `generator.ts` already does.
 */
function pathConventionGate(args: {
  filePath: string;
  testType: TestType;
  language: Language | null;
  ecosystemId: string | null;
  item: PlanItem | null;
}): { outcome: GateOutcome; correctedFilePath: string | null } {
  const { filePath, testType, language, ecosystemId, item } = args;

  /*
   * A spec-driven type's path belongs to the spec store (`specFilePathFor`
   * writes `<dir>/<slug>.json`), not to a language runner — no runner ever
   * collects it. Checking it against an ecosystem's `filePattern` would warn on
   * every API, visual and accessibility test in the product.
   */
  if (generationStrategyFor(testType).mode === 'spec') {
    return {
      outcome: pass(
        'PATH_CONVENTION',
        `A ${testType} test is executed from its spec by its runner plugin, not collected from disk by a language runner, so no file-naming convention applies to it.`,
      ),
      correctedFilePath: null,
    };
  }

  const ecosystem = ecosystemFor(language, testType, ecosystemId);
  if (!ecosystem) {
    return {
      outcome: unavailable(
        'PATH_CONVENTION',
        'Whether this runner can collect this file could not be checked: neither a language nor a known runner was supplied, and every file-naming rule in this repo belongs to a specific runner.',
        [`filePath: ${filePath}`],
      ),
      correctedFilePath: null,
    };
  }

  if (ecosystem.filePattern.test(filePath)) {
    return {
      outcome: pass(
        'PATH_CONVENTION',
        `${ecosystem.label} collects "${filePath}" (${ecosystem.pathRule}).`,
      ),
      correctedFilePath: null,
    };
  }

  const suggested = item
    ? testFilePath(ecosystem, { feature: item.feature, title: item.title })
    : null;

  if (!suggested) {
    return {
      outcome: warn(
        'PATH_CONVENTION',
        `${ecosystem.label} does not collect "${filePath}" (${ecosystem.pathRule}), so this test would sit in the repository and never run — and the suite would go green without it.`,
        [`Expected a path matching ${String(ecosystem.filePattern)}; no plan item was supplied, so no replacement path could be computed.`],
      ),
      correctedFilePath: null,
    };
  }

  return {
    outcome: warn(
      'PATH_CONVENTION',
      `"${filePath}" is not a path ${ecosystem.label} collects (${ecosystem.pathRule}), so it was corrected to "${suggested}" — a test at the original path would never have run.`,
      // detail[0] is the corrected path verbatim, for a caller coding against
      // the report shape that has no `correctedFilePath` field.
      [suggested, `Expected a path matching ${String(ecosystem.filePattern)}; got "${filePath}".`],
    ),
    correctedFilePath: suggested,
  };
}

/**
 * The ecosystem whose collection rule applies, from whatever the caller knew.
 * An explicit runner id wins (a Java shop on TestNG, a Python shop on Robot);
 * otherwise the language decides, through the same `resolveEcosystem` the
 * generator used to choose the prompt — so the rule we enforce is the rule the
 * model was given.
 */
function ecosystemFor(
  language: Language | null,
  testType: TestType,
  ecosystemId: string | null,
): Ecosystem | null {
  if (ecosystemId && isEcosystemId(ecosystemId)) {
    return resolveEcosystem({
      language: language ?? 'TYPESCRIPT',
      framework: 'PLAYWRIGHT',
      testType,
      runner: ecosystemId,
    });
  }
  if (!language) return null;
  const framework: UiFramework | undefined = FRAMEWORKS_BY_LANGUAGE[language][0];
  if (!framework) return null;
  return resolveEcosystem({ language, framework, testType, runner: null });
}

// ─── Gate: DUPLICATE ─────────────────────────────────────────────────────────

/**
 * A test the suite already has inflates the numerator without covering
 * anything — the single most direct way the coverage number can lie.
 *
 * The comparison is `suite-health.ts`'s, not a second one. `findDuplicates`
 * already carries the eligibility filter (a test we could not read completely
 * is not comparable, because a partial reading can only make two tests look
 * MORE alike), the facet weights (assertions dominate: two tests that walk the
 * same pages and check different things are two tests), the IDENTICAL rule and
 * the recommendation wording. Writing a second notion of similarity would mean
 * the duplicate report and the admission gate could disagree about the same two
 * tests, and then neither is believable.
 *
 * The one judgement added here is the FAIL line, and it is taken from that
 * module's own conclusion: when the assertions differ, `findDuplicates` says
 * keep both, because a differing assertion is usually the whole reason the
 * second test exists. So a near-duplicate that checks something new is a WARN,
 * and only "same journey, same checks" is a refusal.
 */
function duplicateGate(args: {
  code: string;
  filePath: string;
  testType: TestType;
  spec: unknown;
  item: PlanItem | null;
  existing: AdmissionInput['existing'];
}): GateOutcome {
  const { code, filePath, testType, spec, item, existing } = args;

  if (!existing) {
    return unavailable(
      'DUPLICATE',
      'Whether the suite already has this test was not checked: no existing tests were supplied for comparison.',
    );
  }
  if (existing.length === 0) {
    return pass('DUPLICATE', 'The suite has no other tests, so this one cannot duplicate anything.');
  }

  const candidate = toSuiteHealthTest({ id: CANDIDATE_ID, code, filePath, testType, spec, item });
  const others = existing.map((test) =>
    toSuiteHealthTest({
      id: test.id,
      name: test.name,
      code: test.code ?? '',
      filePath: test.filePath,
      testType: test.type,
      spec: test.spec,
      item: null,
    }),
  );

  const behaviors = [candidate, ...others].map(extractBehavior);
  const scan = findDuplicates(behaviors, { maxReportedPairs: DUPLICATE_MAX_REPORTED_PAIRS });

  const notCompared = scan.ineligible.find((entry) => entry.testId === CANDIDATE_ID);
  if (notCompared) {
    return unavailable(
      'DUPLICATE',
      `Whether the suite already has this test could not be decided: ${notCompared.reason}.`,
      [`Compared against ${others.length} existing test(s); this one was not eligible.`],
    );
  }

  const pairs = scan.pairs.filter(
    (pair) => pair.a.testId === CANDIDATE_ID || pair.b.testId === CANDIDATE_ID,
  );

  /*
   * Honest completeness, in two steps rather than one.
   *
   * `scan.complete` is false whenever ANY test was ineligible, including the
   * other ones — but "three of your spec-driven API tests could not be read"
   * is not a reason to refuse to answer about this test, and treating it as one
   * would make the gate permanently UNAVAILABLE in every real suite. So the
   * distinction is whether a comparison HAPPENED at all: nothing compared means
   * nothing known; some compared means a PASS that names what it skipped.
   */
  const otherIneligible = scan.ineligible.filter((entry) => entry.testId !== CANDIDATE_ID);
  const comparedAgainst = others.length - otherIneligible.length;

  if (pairs.length === 0) {
    if (comparedAgainst === 0) {
      return unavailable(
        'DUPLICATE',
        `Whether the suite already has this test could not be decided: none of the ${others.length} existing test(s) could be read well enough to compare.`,
        capped(otherIneligible.map((entry) => `${entry.name} [${entry.testId}]: ${entry.reason}`)),
      );
    }
    if (scan.incompleteReason !== null || scan.omittedPairs > 0) {
      return unavailable(
        'DUPLICATE',
        `Whether the suite already has this test could not be decided: the duplicate scan stopped early — ${scan.incompleteReason ?? `${scan.omittedPairs} qualifying pair(s) went unreported`}.`,
      );
    }
    return pass(
      'DUPLICATE',
      `Nothing among the ${comparedAgainst} comparable existing test(s) covers the same journey with the same checks.`,
      capped(
        otherIneligible.map(
          (entry) => `Not compared against "${entry.name}" [${entry.testId}]: ${entry.reason}`,
        ),
      ),
    );
  }

  const describe = (pair: (typeof pairs)[number]): string => {
    const other = pair.a.testId === CANDIDATE_ID ? pair.b : pair.a;
    return `${pair.verdict} (${pair.score}) with "${other.name}" [${other.testId}] at ${other.filePath} — identical on ${
      pair.identicalFacets.join(', ') || 'nothing'
    }; differs on ${pair.differingFacets.join(', ') || 'nothing'}. ${pair.recommendation}`;
  };

  const blocking = pairs.filter(
    (pair) =>
      pair.verdict === 'IDENTICAL' || (pair.verdict === 'NEAR_DUPLICATE' && !pair.assertionsDiffer),
  );

  if (blocking.length > 0) {
    const first = blocking[0]!;
    const other = first.a.testId === CANDIDATE_ID ? first.b : first.a;
    return fail(
      'DUPLICATE',
      `The suite already has this test: "${other.name}" walks the same routes, takes the same actions and makes the same assertions, so storing this one would raise the coverage number without covering anything new.`,
      capped([...blocking.map(describe), ...pairs.filter((p) => !blocking.includes(p)).map(describe)]),
    );
  }

  return warn(
    'DUPLICATE',
    `This test overlaps ${pairs.length} existing test(s) but checks something they do not, which is usually the reason a second test exists — worth a human confirming the difference is deliberate.`,
    capped(pairs.map(describe)),
  );
}

// ─── Gate: MUTATION ──────────────────────────────────────────────────────────

/**
 * The strongest possible proof that a test asserts something real: break the
 * code it covers and see whether the test notices. It is also the one gate that
 * cannot exist in a pure function — it needs a mutated build and a test run.
 *
 * It is reported, always UNAVAILABLE, rather than omitted, so that the report
 * says out loud that the strongest check was not performed. It is the ONE
 * UNAVAILABLE deliberately kept out of `reviewFlags`: it can never run here, so
 * a flag for it would appear on every test ever admitted, and a flag that is
 * always present is a flag nobody reads. The remaining UNAVAILABLEs are facts
 * about THIS test (we could not read it, no toolchain was wired, no suite was
 * supplied to compare against) and every one of them is flagged.
 */
function mutationNotWiredHere(): GateOutcome {
  return unavailable(
    'MUTATION',
    'Nobody has confirmed this test would actually fail if the behaviour it covers broke: proving that means running it against a deliberately mutated build, which admission cannot do — the MUTATION runner measures it after the test is stored.',
  );
}

/**
 * An injected gate is somebody else's code inside a function that promises to
 * be total, so it gets the same treatment the toolchain gates get: a
 * try/catch, and its `gate` field overwritten so a mislabelled outcome cannot
 * reach the verdict arithmetic, which keys on it.
 *
 * A gate that THREW is not a gate that passed. It comes back UNAVAILABLE —
 * and, because it was supplied, it is flagged.
 */
async function runInjectedMutationGate(run: () => Promise<GateOutcome>): Promise<GateOutcome> {
  try {
    const outcome = await run();
    return { ...outcome, gate: 'MUTATION' };
  } catch (error) {
    return unavailable(
      'MUTATION',
      `Nobody has confirmed this test would fail if the behaviour it covers broke: the mutation check itself errored (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }
}

// ─── Toolchain gates ─────────────────────────────────────────────────────────

const TOOLCHAIN_MISSING: Record<'SYNTAX' | 'TYPECHECK' | 'FORMAT' | 'LINT', string> = {
  SYNTAX:
    'Nobody has confirmed this file parses: no syntax checker was wired in, so a missing brace would first show up as "the runner produced no report" at run time.',
  TYPECHECK:
    'Nobody has confirmed this file typechecks: no typechecker was wired in, so a call with the wrong arguments would first show up at run time.',
  FORMAT:
    'This file was not formatted to the project\'s style: no formatter was wired in, so it may land in the repository looking foreign to its reviewer.',
  LINT: 'Nobody has run the project\'s lint rules over this file: no linter was wired in, so a rule the team enforces may be broken here.',
};

/**
 * An injected gate is somebody else's code running inside a function that
 * promises to be pure and total. It gets a try/catch, and its answer gets its
 * `gate` field overwritten — a gate that mislabels itself would corrupt the
 * verdict arithmetic, which keys on `gate` and `status`.
 */
async function runToolchainGate(
  id: 'SYNTAX' | 'TYPECHECK' | 'LINT',
  run: ((input: { code: string; filePath: string }) => Promise<GateOutcome>) | undefined,
  input: { code: string; filePath: string },
): Promise<GateOutcome> {
  if (!run) return unavailable(id, TOOLCHAIN_MISSING[id]);
  try {
    const outcome = await run(input);
    return { ...outcome, gate: id };
  } catch (error) {
    return unavailable(
      id,
      `The ${id.toLowerCase()} check could not run: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function runFormatGate(
  run: ToolchainGates['format'] | undefined,
  input: { code: string; filePath: string },
): Promise<{ outcome: GateOutcome; code: string | null }> {
  if (!run) return { outcome: unavailable('FORMAT', TOOLCHAIN_MISSING.FORMAT), code: null };
  try {
    const outcome = await run(input);
    const rewritten = typeof outcome.code === 'string' && outcome.code !== input.code;
    return {
      outcome: { gate: 'FORMAT', status: outcome.status, why: outcome.why, detail: outcome.detail, line: outcome.line },
      code: rewritten && outcome.status !== 'FAIL' ? outcome.code! : null,
    };
  } catch (error) {
    return {
      outcome: unavailable(
        'FORMAT',
        `The formatter could not run: ${error instanceof Error ? error.message : String(error)}.`,
      ),
      code: null,
    };
  }
}

// ─── Verdict arithmetic ──────────────────────────────────────────────────────

/**
 * These three FAIL classes ARE the product decision, and they are a function of
 * one question: would re-prompting plausibly fix it, and what does being wrong
 * cost?
 *
 *   HARD — SYNTAX, ASSERTIONS, FIDELITY. A file that does not parse, checks
 *   nothing, or implements a different scenario than the one approved is not a
 *   test. Storing it is the original defect. One retry, then refuse: a model
 *   that has already been told exactly what is missing and produced it again is
 *   not going to produce it on the third try, and a refusal is honest where a
 *   stored empty test is not.
 *
 *   SOFT — TYPECHECK, LINT, LOCATORS, NO_LOCK_IN. Real problems, all
 *   mechanically fixable, none of which make the test about the wrong thing.
 *   One retry; then admit WITH FLAGS, because a refused test covers nothing at
 *   all and a flagged brittle locator is worth a human's eye.
 *
 *   TERMINAL — DUPLICATE. Re-prompting cannot fix "you already have this test",
 *   so there is nothing to ask for. Refuse on the first attempt.
 *
 * NO_LOCK_IN is in SOFT and is not in the agreed table; it is placed here on
 * purpose. An `@qaai/` import means the file does not run in the customer's
 * repository, which is severe — but it is a single import line, the most
 * mechanically fixable failure in the list, and today `generator.ts` merely
 * flags it. Admitting with a loud flag after one retry is therefore never worse
 * than the behaviour being replaced.
 */
const HARD_FAIL_GATES = new Set<GateId>(['SYNTAX', 'ASSERTIONS', 'FIDELITY']);
const SOFT_FAIL_GATES = new Set<GateId>(['TYPECHECK', 'LINT', 'LOCATORS', 'NO_LOCK_IN']);
const TERMINAL_FAIL_GATES = new Set<GateId>(['DUPLICATE']);

/** The attempt at which a revisable failure stops being revisable. */
export const FINAL_ATTEMPT = 2;

export function verdictFor(
  gates: readonly GateOutcome[],
  attempt: number,
  revisable = true,
): AdmissionVerdict {
  const failed = gates.filter((g) => g.status === 'FAIL').map((g) => g.gate);

  if (failed.some((gate) => TERMINAL_FAIL_GATES.has(gate))) return 'REFUSE';

  /*
   * An unrevisable artefact is already at its final attempt, whatever the
   * counter says: there is nothing in the loop that could act on a rewrite
   * request. Collapsing it here rather than at the call site means a caller
   * cannot accidentally loop on a REVISE it can never satisfy.
   */
  const last = !revisable || attempt >= FINAL_ATTEMPT;

  const hard = failed.filter((gate) => HARD_FAIL_GATES.has(gate));
  if (hard.length > 0) return last ? 'REFUSE' : 'REVISE';

  const soft = failed.filter((gate) => SOFT_FAIL_GATES.has(gate));
  if (soft.length > 0) return last ? 'ADMIT_WITH_FLAGS' : 'REVISE';

  /*
   * Any FAIL not in a class above — a gate added to GateId without a decision
   * being made about it — is treated as soft rather than ignored. Ignoring it
   * would mean a new gate silently does nothing, which is this file's own
   * failure mode.
   */
  if (failed.length > 0) return last ? 'ADMIT_WITH_FLAGS' : 'REVISE';

  if (gates.some((g) => g.status === 'WARN')) return 'ADMIT_WITH_FLAGS';
  return 'ADMIT';
}

// ─── Review flags ────────────────────────────────────────────────────────────

/**
 * What a human reads on the test row. Plain sentences, no gate ids, no jargon,
 * and — the point of rule 2 — one line for every gate that did not run, so
 * "admitted" never silently means "unchecked".
 */
function reviewFlagsFor(
  gates: readonly GateOutcome[],
  verdict: AdmissionVerdict,
  mutationWasInjected: boolean,
): string[] {
  const flags: string[] = [];

  for (const gate of gates) {
    if (gate.status === 'WARN') {
      flags.push(gate.why);
      continue;
    }
    if (gate.status === 'UNAVAILABLE') {
      /*
       * The one conditional suppression. With no mutation gate wired in, this
       * flag would appear on every test ever admitted and mean nothing. With
       * one wired in, UNAVAILABLE is a fact about THIS test — no source found,
       * an unsupported language, a trial that timed out — and hiding it would
       * make "admitted" silently mean "unchecked", which is the thing rule 2
       * of this file exists to forbid.
       */
      if (gate.gate === 'MUTATION' && !mutationWasInjected) continue;
      flags.push(gate.why);
      continue;
    }
    if (gate.status === 'FAIL' && verdict === 'ADMIT_WITH_FLAGS') {
      flags.push(
        `Admitted despite failing a check, after ${FINAL_ATTEMPT} attempts — refusing it would leave this behaviour untested, so a human should read it before trusting it: ${gate.why}`,
      );
    }
  }

  return flags;
}

// ─── The revise prompt ───────────────────────────────────────────────────────

/**
 * Fed to the model verbatim, so it has to read as INSTRUCTIONS, not as a
 * report. "The ASSERTIONS gate returned FAIL" tells a model nothing it can act
 * on; "add an assertion that proves the total is $42.00, like this:" does.
 *
 * Every item quotes the offending lines, because the single most common way a
 * repair attempt fails is the model rewriting the whole file from the plan and
 * losing what was already right.
 */
function revisePromptFor(args: {
  gates: readonly GateOutcome[];
  item: PlanItem | null;
  dialectId: DialectId | null;
}): string {
  const { gates, item, dialectId } = args;
  const failures = gates.filter((g) => g.status === 'FAIL');
  if (failures.length === 0) return '';

  const instruction = (gate: GateOutcome): string => {
    switch (gate.gate) {
      case 'SYNTAX':
        return 'Fix the syntax error so the file parses. Nothing else about this file can be checked until it does.';
      case 'TYPECHECK':
        return 'Fix the type errors below. Do not silence them with `any`, a cast or an ignore comment — change the code so the call is correct.';
      case 'LINT':
        return "Fix the lint errors below, using the project's own rules rather than disabling them.";
      case 'ASSERTIONS':
        return `Add assertions that prove the behaviour under test actually happened — the specific text, value or count whose absence would mean the feature is broken. Reaching a page is not an assertion.${
          dialectId ? ` In this file's dialect an assertion looks like: ${assertionExampleFor(dialectId)}` : ''
        }`;
      case 'FIDELITY':
        return `Implement the approved assertions listed below. They were reviewed and signed off by a human, and a test that checks something else does not cover them.${
          item ? ` The approved item is "${item.title}".` : ''
        }`;
      case 'LOCATORS':
        return 'Replace the locators listed below. Address each element by its role and accessible name, then by its label, then by its visible text, then by an explicit test id — never by a generated class name, a position among siblings, or a chain of DOM levels. If an element genuinely cannot be reached any other way, say so in a reviewFlag instead of guessing at its structure.';
      case 'NO_LOCK_IN':
        return 'Remove every reference to QAAI from this file, including the import. This test is committed to the customer\'s own repository and has to run there with QAAI uninstalled — use only the ecosystem\'s own libraries.';
      case 'NO_FIXED_SLEEP':
        return 'Replace the fixed sleeps below with a wait for the thing you actually care about: an element state, a response, or a computed value.';
      case 'PATH_CONVENTION':
        return 'Put the file at the path the runner collects, shown below, and make any package, namespace or class declaration inside the file match it.';
      default:
        return `Fix the following: ${gate.why}`;
    }
  };

  const body = failures
    .map((gate, index) => {
      const quotes = gate.detail.length > 0 ? `\n${gate.detail.map((d) => `     ${d}`).join('\n')}` : '';
      return `  ${index + 1}. ${instruction(gate)}\n     Why this was rejected: ${gate.why}${quotes}`;
    })
    .join('\n\n');

  return `The test you produced was not accepted. Fix every numbered item below and return the COMPLETE file again.

${body}

Keep everything that is already correct: do not remove an assertion that is already there, do not rename the test, and do not introduce a fixed sleep to make a wait work. Return the whole file, not a patch.`;
}

// ─── Plumbing ────────────────────────────────────────────────────────────────

/**
 * The shape `suite-health.ts` compares and judges tests in. Admission sees a
 * test that has no database row yet, so the run-history fields it does not know
 * are set to the values of a test that has never run — not guessed at. None of
 * the functions used here read them.
 */
function toSuiteHealthTest(args: {
  id: string;
  name?: string;
  code: string;
  filePath: string;
  testType: TestType;
  spec: unknown;
  item: PlanItem | null;
}): SuiteHealthTestInput {
  const priority: Priority = args.item?.priority ?? 'IMPORTANT';
  return {
    id: args.id,
    name: args.name ?? args.item?.title ?? args.filePath,
    filePath: args.filePath,
    type: args.testType,
    priority,
    feature: args.item?.feature ?? null,
    tags: [],
    code: args.code,
    spec: args.spec ?? null,
    flakeRate: 0,
    quarantined: false,
    consecutiveFailures: 0,
  };
}

/** Declaration order, so a report always lists its gates the same way. */
const GATE_ORDER: readonly GateId[] = [
  'SYNTAX',
  'TYPECHECK',
  'FORMAT',
  'LINT',
  'ASSERTIONS',
  'LOCATORS',
  'FIDELITY',
  'NO_LOCK_IN',
  'NO_FIXED_SLEEP',
  'PATH_CONVENTION',
  'DUPLICATE',
  'MUTATION',
];

// ─── admit ───────────────────────────────────────────────────────────────────

/**
 * Run every gate, once, and return one verdict.
 *
 * ORDER MATTERS in two places and nowhere else:
 *
 *   1. SYNTAX runs first, and when it fails the other three toolchain gates are
 *      not run. A typechecker and a linter pointed at a file with a missing
 *      brace produce a wall of cascading parse errors that bury the one real
 *      problem, and `revisePrompt` is fed to a model verbatim.
 *
 *   2. FORMAT may rewrite the code, and every pure gate then runs against the
 *      REWRITTEN text — so every line number in the report refers to
 *      `report.code`, the code as admitted. A report whose line numbers point
 *      into a version of the file that no longer exists is worse than no line
 *      numbers.
 *
 * Everything else runs unconditionally, including the pure gates when SYNTAX
 * failed. A dialect assertion scan is line-based and reads a file with a
 * missing brace perfectly well, and one `revisePrompt` naming every problem
 * costs one strong-tier call where two sequential ones cost two.
 */
export async function admit(input: AdmissionInput): Promise<AdmissionReport> {
  const attempt = input.attempt ?? 1;
  const { filePath, testType, item } = input;
  const language = input.language ?? null;
  const ecosystemId = input.ecosystemId ?? null;
  const spec = input.spec;

  const dialectId = resolveDialect({ filePath, ecosystemId, language });

  // ── Toolchain, in order ──
  /*
   * Bound at the call site rather than passed as bare references. An injected
   * gate is a METHOD on an object the caller built, so handing
   * `input.toolchain.syntax` around detaches it from its `this` — which works
   * for the arrow-function implementations we ship and breaks silently for a
   * class-based one somebody writes later.
   */
  const injected = input.toolchain;
  const syntax = await runToolchainGate(
    'SYNTAX',
    injected && ((i) => injected.syntax(i)),
    { code: input.code, filePath },
  );

  let code = input.code;
  let format: GateOutcome;
  let typecheck: GateOutcome;
  let lint: GateOutcome;

  if (syntax.status === 'FAIL') {
    const why =
      'Not run: this file does not parse, so this check would only repeat the syntax error. Fix the syntax first.';
    format = unavailable('FORMAT', why);
    typecheck = unavailable('TYPECHECK', why);
    lint = unavailable('LINT', why);
  } else {
    const formatted = await runFormatGate(injected && ((i) => injected.format(i)), { code, filePath });
    format = formatted.outcome;
    if (formatted.code !== null) code = formatted.code;
    typecheck = await runToolchainGate('TYPECHECK', injected && ((i) => injected.typecheck(i)), {
      code,
      filePath,
    });
    lint = await runToolchainGate('LINT', injected && ((i) => injected.lint(i)), { code, filePath });
  }

  // ── Pure gates, against the code as it will be admitted ──
  const assertions = assertionsGate({ code, filePath, testType, spec, dialectId, item });
  const locators = locatorsGate({ code, dialectId });
  const fidelity = fidelityGate({ code, spec, item, testType, dialectId });
  const noLockIn = noLockInGate({ code, dialectId });
  const noSleep = noFixedSleepGate({ code, dialectId });
  const path = pathConventionGate({ filePath, testType, language, ecosystemId, item });
  const duplicate = duplicateGate({
    code,
    filePath,
    testType,
    spec,
    item,
    existing: input.existing,
  });
  const mutation = input.mutation
    ? await runInjectedMutationGate(input.mutation)
    : mutationNotWiredHere();

  const byId = new Map<GateId, GateOutcome>(
    [
      syntax,
      typecheck,
      format,
      lint,
      assertions,
      locators,
      fidelity,
      noLockIn,
      noSleep,
      path.outcome,
      duplicate,
      mutation,
    ].map((outcome) => [outcome.gate, outcome]),
  );
  const gates = GATE_ORDER.map((id) => byId.get(id)).filter((g): g is GateOutcome => g !== undefined);

  const verdict = verdictFor(gates, attempt, input.revisable ?? true);

  return {
    verdict,
    gates,
    reviewFlags: reviewFlagsFor(gates, verdict, input.mutation !== undefined),
    revisePrompt: verdict === 'REVISE' ? revisePromptFor({ gates, item, dialectId }) : null,
    code,
    correctedFilePath: path.correctedFilePath,
  };
}

// Exported for the test suite, which exercises the pieces as well as the whole.
export const __internal = {
  classifySelector,
  looksLikeSelector,
  looksLikeUtilityClass,
  stripCommentsKeepStrings,
  tokensOf,
  variantsOf,
  tokenOverlap,
  stringLiterals,
};
