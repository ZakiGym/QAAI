/**
 * The deflaker (§3.3/§5) — what a FLAKE verdict is supposed to produce.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Triage could say FLAKE, and the only machinery downstream of that word was
 * QUARANTINE. Quarantine does not repair a test; it stops the test from gating,
 * which is to say it SUPPRESSES THE SIGNAL and leaves the flake exactly where it
 * was. A product that answers "this test is unreliable" with "fine, we will stop
 * listening to it" has inverted its own purpose — and the flake radar in
 * apps/worker/src/processors/flake.ts says so in its own header ("quarantine
 * SUPPRESSES a signal"). This module is the other half: given a flake and its
 * evidence, propose the REPAIR.
 *
 * ── THE MODEL-FREE HALF, AND WHY IT IS THE IMPORTANT HALF ───────────────────
 *
 * A fixed sleep is a deterministic finding with a deterministic fix. So is an
 * un-awaited action. Those two account for most of the flakes anyone can point
 * at in a Playwright suite, they can be found with a scanner and fixed with a
 * substitution, and doing it deterministically means:
 *
 *   • it works with no ANTHROPIC_API_KEY, like every other deterministic path
 *     in this codebase;
 *   • the customer can re-derive the fix themselves and check our arithmetic,
 *     which is the same property that makes the coverage denominator
 *     trustworthy;
 *   • there is no temperature. The same test produces the same patch forever,
 *     so the review queue does not churn.
 *
 * What is NOT deterministic is named as such and never patched. An isolated
 * fixture changes where a test gets its data; a deterministic seed changes what
 * the data is; a web-first assertion rewrite changes what is being asserted
 * (`toHaveText` normalises whitespace, `toBe` on `textContent()` does not).
 * Each of those is a DECISION, and this module's job on a decision is to state
 * the repair precisely and hand it to a person — not to guess, and not to
 * quietly report "no findings" because the easy cases did not match.
 * `fixable: false` with a reason is a real answer here; a silent zero is not.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 *
 * NEVER WEAKEN AN ASSERTION TO STABILISE A TEST. It is the rule the Healer
 * lives by and the reason anyone would trust a tool that edits their tests. A
 * deflake fix may add a wait, may add an assertion, may delete a sleep — it may
 * never delete, loosen or wrap an assertion, and it may never add a sleep of its
 * own. Every emitted patch is checked against its own input for exactly that
 * (`selfCheck` below) and a patch that fails the check is thrown away with the
 * reason recorded, because a deflaker that weakens assertions is strictly worse
 * than the quarantine it was built to replace.
 */

import { createPatch } from 'diff';
import { countAssertions, findTestBlocks, resolveDialect } from '@qaai/shared';
import type { DialectId } from '@qaai/shared';
import { FIXED_SLEEP_PATTERNS } from './ecosystem-prompts.js';
import { applyHealDiff } from './heal-apply.js';
import { stripComments } from './suite-health.js';

// ─── Findings ────────────────────────────────────────────────────────────────

export type DeflakeFindingKind =
  /** A wait on the clock instead of on a condition. Deterministically fixable. */
  | 'FIXED_SLEEP'
  /** A promise-returning action nobody awaited. Deterministically fixable. */
  | 'UNAWAITED_ACTION'
  /** `expect(await locator.textContent())` — read once, asserted once, no retry. */
  | 'EAGER_READ_ASSERTION'
  /** A hard-coded unique key, which two runs or two tests will collide on. */
  | 'SHARED_FIXTURE'
  /** Randomness or wall-clock time inside the test body. */
  | 'NONDETERMINISTIC_DATA';

export interface DeflakeFinding {
  kind: DeflakeFindingKind;
  /** 1-based line in the test's own source. */
  line: number;
  /** The line itself, whitespace-collapsed. The evidence a reviewer reads. */
  quote: string;
  /** Why this makes a test intermittent. */
  why: string;
  /** The repair, named precisely — whether or not this module can perform it. */
  repair: string;
  /** True when this module produced the patch for it rather than describing it. */
  patched: boolean;
}

export interface DeflakeEvidence {
  /** The triage verdict's own explanation, when a verdict drove this. */
  verdictExplanation?: string | null;
  /** The failing step's error, which usually names the timeout or the locator. */
  failureMessage?: string | null;
  /** The flake radar's measurement, when one exists. */
  measured?: { failed: number; of: number } | null;
}

export interface DeflakeInput {
  testName: string;
  filePath: string;
  /** The test's current source. Spec-driven types pass their inert pointer here. */
  code: string;
  /** Resolves the assertion lexicon when the path cannot settle it. */
  ecosystemId?: string | null;
  evidence?: DeflakeEvidence;
}

export interface DeflakeProposal {
  /** True only when `diff` is a patch this module has already proven applies. */
  fixable: boolean;
  /** Unified diff against `code`, or '' when there is nothing to apply. */
  diff: string;
  /** The sentence a reviewer reads. Says what was fixed AND what was not. */
  explanation: string;
  /**
   * 0–1. The LOWEST confidence of the fixes actually applied, because a patch is
   * accepted or rejected as a whole — reporting the best one would describe a
   * decision nobody gets to make.
   */
  confidence: number;
  /**
   * Always STRUCTURAL. A deflake adds, removes or reorders statements; it is
   * never selector-only, so it is never eligible for unattended apply. That is
   * deliberate: an unattended rewrite of how a test waits is a bigger claim
   * than an unattended rename of a button.
   */
  riskLevel: 'STRUCTURAL';
  findings: DeflakeFinding[];
  /** The repairs this module will not perform. One sentence each, actionable. */
  recommendations: string[];
  /** Why there is no patch. Null when there is one. */
  unfixableReason: string | null;
  /**
   * Assertion counts before and after, in the test's own dialect — NULL when the
   * dialect could not be resolved, which is the honest value. A count of 0
   * before and 0 after in an unreadable file proves nothing, and the
   * never-weaken check below refuses to emit a patch in that state rather than
   * reporting a comparison it did not make.
   */
  assertionsBefore: number | null;
  assertionsAfter: number | null;
  /** The dialect the analysis ran in, or null. Stated so a reader can discount it. */
  dialect: DialectId | null;
}

// ─── The Playwright-shape gate ───────────────────────────────────────────────

/**
 * Whether the deterministic REWRITES may run on this file.
 *
 * Detection is multilingual — `FIXED_SLEEP_PATTERNS` covers seventeen ways to
 * sleep across a dozen ecosystems — but REWRITING is not. `locator.waitFor()`
 * and `expect(locator).toBeVisible()` are Playwright-JavaScript, and emitting
 * them into a pytest file or a Cypress spec would produce a patch that does not
 * run. So the findings are reported for every language and the patch is only
 * ever produced here.
 *
 * `cy.` is excluded explicitly rather than by omission: Cypress commands are
 * synchronous-by-queue, so the "add the missing await" fix is actively WRONG
 * there — awaiting a Cypress chainable changes when the command runs. A file
 * that mentions `cy.` gets findings and no patch, with the reason stated.
 */
function isPlaywrightJs(code: string, dialect: DialectId | null): boolean {
  if (dialect !== 'JS_EXPECT' && dialect !== 'JS_CHAI') return false;
  if (/\bcy\s*\./.test(code)) return false;
  return /\bpage\s*\.|@playwright\/test/.test(code);
}

/** Does this expression actually name an element, rather than a value? */
const LOCATOR_FACTORY_IN_EXPR =
  /\.(?:getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|getByAltText|getByTitle|getByDisplayValue|locator|frameLocator)\s*\(/;

/** Matchers that poll. An `expect` using one of these IS a wait already. */
const WEB_FIRST_MATCHER =
  /\.(?:toBeVisible|toBeHidden|toBeAttached|toBeEnabled|toBeDisabled|toBeEditable|toBeChecked|toBeFocused|toBeEmpty|toBeInViewport|toHaveText|toContainText|toHaveValue|toHaveValues|toHaveAttribute|toHaveClass|toHaveCount|toHaveCSS|toHaveId|toHaveJSProperty|toHaveURL|toHaveTitle|toHaveScreenshot|toHaveAccessibleName|toHaveAccessibleDescription|toHaveRole)\s*\(/;

/** The actions whose receiver is an element we can wait for. */
const ACTION_CALL =
  /\.\s*(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|hover|dragTo|tap|focus|clear|selectText|scrollIntoViewIfNeeded)\s*\(/;

/** Navigation and actions, for the un-awaited check. `goto` races just as hard. */
const AWAITABLE_CALL =
  /\.\s*(goto|click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|hover|dragTo|tap|focus|clear|selectText|waitFor|waitForURL|waitForLoadState|waitForResponse|waitForRequest|scrollIntoViewIfNeeded)\s*\(/;

/** A literal that is a unique key in somebody's database. */
const UNIQUE_KEY_LITERAL =
  /(['"`])[^'"`\s]{1,64}@[A-Za-z0-9.-]{2,}\.[A-Za-z]{2,}\1|(['"`])(?:user|admin|test)[-_.]?[A-Za-z0-9]{0,20}\2/;

const NONDETERMINISTIC_CALL = /\bMath\s*\.\s*random\s*\(|\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/;

/** The failure messages that say "something already exists" in anyone's words. */
const COLLISION_EVIDENCE =
  /already exists|already registered|already taken|duplicate|unique constraint|conflict|409/i;

function collapse(line: string): string {
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Balanced parens/brackets — a cut expression that is not balanced is not usable. */
function balanced(expr: string): boolean {
  let round = 0;
  let square = 0;
  let curly = 0;
  for (const ch of expr) {
    if (ch === '(') round += 1;
    else if (ch === ')') round -= 1;
    else if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    else if (ch === '{') curly += 1;
    else if (ch === '}') curly -= 1;
    if (round < 0 || square < 0 || curly < 0) return false;
  }
  return round === 0 && square === 0 && curly === 0;
}

/**
 * The element expression a statement acts on — `page.getByRole('button', …)`
 * out of `await page.getByRole('button', …).click();`.
 *
 * Returns null rather than guessing. A statement whose receiver we cannot read
 * exactly is a statement we do not rewrite: a half-read locator produces a wait
 * on the wrong element, which is a new flake wearing the fix's clothes.
 */
export function elementExpressionOf(statement: string): string | null {
  const action = ACTION_CALL.exec(statement);
  if (!action) return null;

  const head = statement.slice(0, action.index);
  const expr = head.replace(/^\s*(?:await\s+|return\s+(?:await\s+)?|void\s+)?/, '').trim();
  if (!expr || !LOCATOR_FACTORY_IN_EXPR.test(expr) || !balanced(expr)) return null;
  // A locator stored in a variable and then acted on is fine; an assignment on
  // this line is not, because the head would include `const x =`.
  if (/[=;]/.test(expr)) return null;
  return expr;
}

/** Is this statement already a polling assertion about an element? */
function isWebFirstAssertion(statement: string): boolean {
  if (!/\bexpect(?:\.soft|\.poll)?\s*\(/.test(statement)) return false;
  if (!WEB_FIRST_MATCHER.test(statement)) return false;
  // `expect(someString).toHaveText(...)` is not possible, but
  // `expect(await x.textContent()).toBe(...)` is — and that one is a VALUE
  // assertion that does not poll. Require the subject to name an element.
  return LOCATOR_FACTORY_IN_EXPR.test(statement) || /\bexpect\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(statement);
}

/** The next line with code on it, or -1. */
function nextCodeLine(stripped: readonly string[], from: number): number {
  for (let i = from + 1; i < stripped.length; i += 1) {
    const line = stripped[i];
    if (line !== undefined && line.trim().length > 0) return i;
  }
  return -1;
}

// ─── Detection ───────────────────────────────────────────────────────────────

interface SleepSite {
  index: number;
  /** 'REDUNDANT' — the next statement already waits. 'RETARGET' — we can wait. */
  fix: 'REDUNDANT' | 'RETARGET' | 'NONE';
  element: string | null;
  nextIndex: number;
}

function findSleepSites(stripped: readonly string[], playwright: boolean): SleepSite[] {
  const sites: SleepSite[] = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i];
    if (line === undefined) continue;
    if (!FIXED_SLEEP_PATTERNS.some((pattern) => pattern.test(line))) continue;

    const nextIndex = nextCodeLine(stripped, i);
    const next = nextIndex === -1 ? '' : (stripped[nextIndex] ?? '');

    if (!playwright) {
      sites.push({ index: i, fix: 'NONE', element: null, nextIndex });
      continue;
    }
    if (nextIndex !== -1 && isWebFirstAssertion(next)) {
      sites.push({ index: i, fix: 'REDUNDANT', element: null, nextIndex });
      continue;
    }
    const element = nextIndex === -1 ? null : elementExpressionOf(next);
    sites.push({
      index: i,
      fix: element ? 'RETARGET' : 'NONE',
      element,
      nextIndex,
    });
  }
  return sites;
}

function findUnawaited(stripped: readonly string[], playwright: boolean): number[] {
  if (!playwright) return [];
  const out: number[] = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const raw = stripped[i];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (!AWAITABLE_CALL.test(line)) continue;
    if (/\bawait\b|\breturn\b|\bvoid\b|\.then\s*\(|\.catch\s*\(|=>/.test(line)) continue;
    // An assignment keeps the promise, which is a style, not a race.
    if (/^(?:const|let|var)\b|^[A-Za-z_$][\w$.]*\s*=[^=]/.test(line)) continue;
    // An element of `Promise.all([...])` is awaited by the array, one line up.
    if (!/;\s*$/.test(line) || line.endsWith(',')) continue;
    if (!/^(?:page|[A-Za-z_$][\w$]*)\s*\./.test(line)) continue;
    out.push(i);
  }
  return out;
}

function findEagerReads(stripped: readonly string[], playwright: boolean): number[] {
  if (!playwright) return [];
  const out: number[] = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i];
    if (line === undefined) continue;
    if (!/\.(?:textContent|innerText|inputValue|getAttribute|isVisible|isEnabled|count)\s*\(/.test(line)) {
      continue;
    }
    if (!/\bawait\b/.test(line)) continue;
    // Either `expect(await x.textContent())` on one line, or a read assigned
    // here and asserted within the next two lines.
    if (/\bexpect\s*\(/.test(line)) {
      out.push(i);
      continue;
    }
    const assigned = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!assigned) continue;
    const name = assigned[1]!;
    for (let j = i + 1; j < Math.min(stripped.length, i + 4); j += 1) {
      const later = stripped[j];
      if (later === undefined) continue;
      if (new RegExp(`\\bexpect\\s*\\(\\s*${name}\\b`).test(later)) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

// ─── The rewrite ─────────────────────────────────────────────────────────────

/**
 * The wait statement to put where a sleep was.
 *
 * `expect(...).toBeVisible()` when the file already has `expect` in scope, and
 * `locator.waitFor({ state: 'visible' })` when it does not — because adding an
 * import is a bigger edit than this module is willing to make unattended, and a
 * patch that references an undefined `expect` does not parse, which the
 * post-heal SYNTAX gate would (correctly) refuse.
 *
 * Both are web-first: they poll until the condition holds or the test's own
 * timeout expires. The `expect` form is preferred because it also ASSERTS the
 * precondition the sleeping test was silently assuming, which is an assertion
 * ADDED — the direction the never-weaken rule is happy about.
 */
function waitStatement(element: string, indent: string, hasExpect: boolean): string {
  return hasExpect
    ? `${indent}await expect(${element}).toBeVisible();`
    : `${indent}await ${element}.waitFor({ state: 'visible' });`;
}

function indentOf(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? '';
}

// ─── Self-check ──────────────────────────────────────────────────────────────

interface SelfCheck {
  ok: boolean;
  reason: string | null;
  assertionsBefore: number | null;
  assertionsAfter: number | null;
}

/**
 * Refuse our own output unless it is strictly better than its input.
 *
 * This module is a code generator pointed at a customer's test, and the fact
 * that it is deterministic is not a safety argument — a deterministic bug fires
 * every time. So the patch is checked against the file it came from:
 *
 *  1. ASSERTIONS NEVER DECREASE. The one rule. Checked in the test's own
 *     dialect, and when the dialect is unknown the patch is REFUSED rather than
 *     emitted with an unchecked claim — unlike `applyHealDiff`, which may let a
 *     human-reviewed heal through with a `review` note, because there a refusal
 *     costs the customer their only fix for a red test. Here a refusal costs
 *     nothing: the test was flaky before and stays flaky, and we say why.
 *  2. TEST BLOCKS NEVER DISAPPEAR. A deflake may not delete a test.
 *  3. NO NEW SLEEP, AND STRICTLY FEWER OF THEM. The whole point.
 *  4. SOMETHING CHANGED. A no-op patch in a review queue is noise.
 */
function selfCheck(before: string, after: string, dialect: DialectId | null): SelfCheck {
  const countSleeps = (code: string): number =>
    code.split('\n').filter((line) => FIXED_SLEEP_PATTERNS.some((p) => p.test(line))).length;

  if (after === before) {
    return {
      ok: false,
      reason: 'The rewrite produced no change.',
      assertionsBefore: null,
      assertionsAfter: null,
    };
  }
  if (dialect === null) {
    return {
      ok: false,
      reason:
        "QAAI has no assertion lexicon for this file type, so nobody could check that the rewrite keeps every assertion the test already had. A deflake fix is not worth guessing about — the test keeps failing intermittently either way, and this way you are told.",
      assertionsBefore: null,
      assertionsAfter: null,
    };
  }

  const assertionsBefore = countAssertions(before, dialect);
  const assertionsAfter = countAssertions(after, dialect);
  if (assertionsAfter < assertionsBefore) {
    return {
      ok: false,
      reason: `The rewrite would remove ${assertionsBefore - assertionsAfter} assertion(s). Stabilising a test by asserting less is the one repair this product will not make.`,
      assertionsBefore,
      assertionsAfter,
    };
  }

  const blocksBefore = findTestBlocks(before, dialect).length;
  const blocksAfter = findTestBlocks(after, dialect).length;
  if (blocksBefore > 0 && blocksAfter < blocksBefore) {
    return {
      ok: false,
      reason: `The rewrite would remove ${blocksBefore - blocksAfter} test block(s).`,
      assertionsBefore,
      assertionsAfter,
    };
  }

  const sleepsBefore = countSleeps(before);
  const sleepsAfter = countSleeps(after);
  if (sleepsAfter >= sleepsBefore && sleepsBefore > 0) {
    return {
      ok: false,
      reason: 'The rewrite did not remove any fixed sleep.',
      assertionsBefore,
      assertionsAfter,
    };
  }
  if (sleepsAfter > sleepsBefore) {
    return {
      ok: false,
      reason: 'The rewrite introduced a fixed sleep.',
      assertionsBefore,
      assertionsAfter,
    };
  }

  return { ok: true, reason: null, assertionsBefore, assertionsAfter };
}

// ─── The generator ───────────────────────────────────────────────────────────

/**
 * Confidence in each deterministic fix, as documented constants rather than
 * numbers sprinkled through the code.
 *
 * They are not guesses about whether the fix is CORRECT — each one is a
 * mechanical substitution whose correctness is checked by `selfCheck` and by the
 * post-heal gates. They are statements about whether the fix is SUFFICIENT: how
 * likely it is that removing this particular smell is the whole reason the test
 * was intermittent.
 */
export const DEFLAKE_CONFIDENCE = {
  /**
   * Deleting a sleep that sits in front of a web-first assertion. The assertion
   * already polls, so the sleep was doing nothing but adding wall-clock time —
   * which means deleting it cannot make the test less reliable than it is.
   */
  REDUNDANT_SLEEP: 0.9,
  /**
   * Replacing a sleep with a wait on the element the next statement touches.
   * Very likely the right wait; not certain to be the ONLY thing the test was
   * racing against, which is the whole reason this is not 1.
   */
  RETARGETED_SLEEP: 0.8,
  /**
   * Adding a missing `await`. Mechanically certain to be an improvement — an
   * un-awaited action is a race by construction — and still not 1, because a
   * test can be flaky for a second reason this fix does not touch.
   */
  MISSING_AWAIT: 0.85,
} as const;

/**
 * Propose the repair for a flaky test, deterministically where that is possible.
 *
 * Calls no model, under any circumstance. Every path through this function works
 * with no API key, which is the same guarantee `coverage.ts` and
 * `spec-strategies.ts` make and for the same reason: the deterministic answer is
 * the one a customer can audit.
 */
export function proposeDeflake(input: DeflakeInput): DeflakeProposal {
  const dialect = resolveDialect({
    filePath: input.filePath,
    ecosystemId: input.ecosystemId ?? null,
  });
  const original = input.code;
  const lines = original.split('\n');
  const strippedSource = stripComments(original);
  const stripped = strippedSource.text.split('\n');
  const playwright = !strippedSource.unreliable && isPlaywrightJs(strippedSource.text, dialect);
  const hasExpect = /\bexpect(?:\.soft|\.poll)?\s*\(/.test(strippedSource.text);

  const findings: DeflakeFinding[] = [];
  const recommendations: string[] = [];
  const appliedConfidences: number[] = [];

  // Lines to delete and lines to insert before, decided before anything is
  // rewritten so two fixes cannot fight over the same line.
  const deletions = new Set<number>();
  const insertions = new Map<number, string>();
  const awaitFixes = new Set<number>();

  // ─ Fixed sleeps ─
  for (const site of findSleepSites(stripped, playwright)) {
    const quote = collapse(lines[site.index] ?? '');
    if (site.fix === 'REDUNDANT') {
      deletions.add(site.index);
      appliedConfidences.push(DEFLAKE_CONFIDENCE.REDUNDANT_SLEEP);
      findings.push({
        kind: 'FIXED_SLEEP',
        line: site.index + 1,
        quote,
        why: 'It waits on the clock. On a busy machine the wait is too short and the test fails; on a fast one it is pure delay.',
        repair:
          'Deleted: the very next statement is a web-first assertion, which already polls until the condition holds. The sleep was adding wall-clock time and nothing else.',
        patched: true,
      });
      continue;
    }
    if (site.fix === 'RETARGET' && site.element) {
      deletions.add(site.index);
      insertions.set(
        site.index,
        waitStatement(site.element, indentOf(lines[site.index] ?? ''), hasExpect),
      );
      appliedConfidences.push(DEFLAKE_CONFIDENCE.RETARGETED_SLEEP);
      findings.push({
        kind: 'FIXED_SLEEP',
        line: site.index + 1,
        quote,
        why: 'It waits on the clock rather than on the element the next statement acts on, so the test fails whenever that element is slower than the guess.',
        repair: hasExpect
          ? `Replaced with \`await expect(${site.element}).toBeVisible()\`, which polls for the thing the test was actually waiting for — and asserts the precondition the sleep was silently assuming.`
          : `Replaced with \`await ${site.element}.waitFor({ state: 'visible' })\`, which polls for the thing the test was actually waiting for. The \`expect\` form would be better still, but this file does not import it and adding an import is a bigger edit than a deflake should make unattended.`,
        patched: true,
      });
      continue;
    }

    findings.push({
      kind: 'FIXED_SLEEP',
      line: site.index + 1,
      quote,
      why: 'It waits on the clock. On a busy machine the wait is too short and the test fails; on a fast one it is pure delay.',
      repair: playwright
        ? 'Wait for the condition instead. QAAI could not do it here because the statement after the sleep does not name an element it could wait for — decide what the test is actually waiting for (a response, a URL, an element state) and wait for that.'
        : `Wait for the condition instead of for the clock. QAAI rewrites this automatically only in Playwright/JavaScript; this file is ${dialect ?? 'in a language QAAI has no lexicon for'}${/\bcy\s*\./.test(strippedSource.text) ? ' and uses Cypress, where commands are queued rather than awaited, so the JavaScript fix would be wrong' : ''}.`,
      patched: false,
    });
    recommendations.push(
      `Line ${site.index + 1}: replace the fixed sleep with a wait on the condition the test depends on.`,
    );
  }

  // ─ Un-awaited actions ─
  for (const index of findUnawaited(stripped, playwright)) {
    if (deletions.has(index)) continue;
    awaitFixes.add(index);
    appliedConfidences.push(DEFLAKE_CONFIDENCE.MISSING_AWAIT);
    findings.push({
      kind: 'UNAWAITED_ACTION',
      line: index + 1,
      quote: collapse(lines[index] ?? ''),
      why: 'The promise is never awaited, so the next statement runs while this one is still in flight. That is a race, and it resolves differently depending on how fast the machine is.',
      repair: 'Added the missing `await`.',
      patched: true,
    });
  }

  // ─ Named, not patched ─
  for (const index of findEagerReads(stripped, playwright)) {
    findings.push({
      kind: 'EAGER_READ_ASSERTION',
      line: index + 1,
      quote: collapse(lines[index] ?? ''),
      why: 'The value is read ONCE and then asserted. If the UI has not settled at the moment of the read, the assertion fails — a web-first assertion would have retried until it settled or the timeout expired.',
      repair:
        'Assert on the locator rather than on a value read from it (`await expect(locator).toHaveText(…)` instead of `expect(await locator.textContent()).toBe(…)`). QAAI will not rewrite this one for you: `toHaveText` normalises whitespace and `toBe` on `textContent()` does not, so the substitution changes what is being asserted — and loosening an assertion to stabilise a test is the one repair this product refuses to make without a person.',
      patched: false,
    });
    recommendations.push(
      `Line ${index + 1}: move the assertion onto the locator so it retries, deciding deliberately whether the whitespace-normalised comparison is the one you want.`,
    );
  }

  const collisionSuspected = COLLISION_EVIDENCE.test(
    `${input.evidence?.failureMessage ?? ''} ${input.evidence?.verdictExplanation ?? ''}`,
  );
  for (let i = 0; i < stripped.length; i += 1) {
    const line = stripped[i];
    if (line === undefined || deletions.has(i)) continue;
    if (/\.\s*(?:fill|type)\s*\(/.test(line) && UNIQUE_KEY_LITERAL.test(line)) {
      findings.push({
        kind: 'SHARED_FIXTURE',
        line: i + 1,
        quote: collapse(lines[i] ?? ''),
        why: collisionSuspected
          ? 'The test types a fixed value that looks like a unique key, and the failure says something already exists — so this test collides with its own previous run, or with a sibling using the same value. It passes once and then fails until something cleans up.'
          : 'The test types a fixed value that looks like a unique key. Two runs, or two tests, using the same one collide: whichever goes second fails, which reads as flakiness.',
        repair:
          'Give the test its own data — a per-run fixture or a value derived from the test id — and clean it up afterwards. QAAI will not rewrite this: changing where a test gets its data changes what the test means, and the right answer depends on your fixtures, not on the text of this line.',
        patched: false,
      });
      recommendations.push(
        `Line ${i + 1}: isolate this fixture so two runs cannot collide on the same unique value.`,
      );
    }
    if (NONDETERMINISTIC_CALL.test(line)) {
      findings.push({
        kind: 'NONDETERMINISTIC_DATA',
        line: i + 1,
        quote: collapse(lines[i] ?? ''),
        why: 'The test generates its own input from randomness or the wall clock, so two runs of this test are not the same test. A failure here cannot be reproduced, which is the worst property a test can have.',
        repair:
          'Seed it. Derive the value from something stable (the test title, a fixture, a fixed seed) so a failing run can be replayed exactly. QAAI will not choose the seed for you — which value is safe to pin depends on what the application does with it.',
        patched: false,
      });
      recommendations.push(
        `Line ${i + 1}: replace the random or clock-derived value with a deterministic seed so a failure can be reproduced.`,
      );
    }
  }

  // ─ Build the patch, if there is one ─
  if (deletions.size === 0 && awaitFixes.size === 0) {
    return {
      fixable: false,
      diff: '',
      explanation: explainUnfixable(input, findings, strippedSource.unreliable, playwright, dialect),
      confidence: 0,
      riskLevel: 'STRUCTURAL',
      findings,
      recommendations: [...new Set(recommendations)],
      unfixableReason: unfixableReason(findings, strippedSource.unreliable, playwright, dialect),
      assertionsBefore: dialect ? countAssertions(original, dialect) : null,
      assertionsAfter: null,
      dialect,
    };
  }

  const rewritten: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const insertion = insertions.get(i);
    if (insertion !== undefined) rewritten.push(insertion);
    if (deletions.has(i)) continue;
    const line = lines[i]!;
    rewritten.push(awaitFixes.has(i) ? line.replace(/^(\s*)/, '$1await ') : line);
  }
  const after = rewritten.join('\n');

  const check = selfCheck(original, after, dialect);
  if (!check.ok) {
    return {
      fixable: false,
      diff: '',
      explanation:
        `QAAI found ${findings.length} reason${findings.length === 1 ? '' : 's'} this test is ` +
        `intermittent and then REFUSED ITS OWN FIX: ${check.reason} ` +
        `The findings below are still worth reading — they are what is making the test unreliable.`,
      confidence: 0,
      riskLevel: 'STRUCTURAL',
      findings: findings.map((finding) => ({ ...finding, patched: false })),
      recommendations: [...new Set(recommendations)],
      unfixableReason: check.reason,
      assertionsBefore: check.assertionsBefore,
      assertionsAfter: check.assertionsAfter,
      dialect,
    };
  }

  const diff = createPatch(input.filePath, original, after, '', '');

  /*
   * The last check, and the one that makes `fixable` mean something: the patch
   * is run through the SAME applier the approval route uses, and must reproduce
   * `after` exactly with no fuzz. A proposal that cannot be applied is a row in
   * a review queue with a dead Approve button — the failure mode the heal
   * preview was built to surface — and there is no reason to ever emit one from
   * a path that has the patched file in hand already.
   */
  const applied = applyHealDiff(original, diff, {
    filePath: input.filePath,
    ecosystemId: input.ecosystemId ?? null,
  });
  if (!applied.ok || applied.code !== after) {
    return {
      fixable: false,
      diff: '',
      explanation:
        `QAAI knows how to fix this test and could not express the fix as a patch that applies ` +
        `cleanly (${applied.reason ?? 'the patch did not reproduce the intended file'}). The findings ` +
        `below name the repair; apply it by hand.`,
      confidence: 0,
      riskLevel: 'STRUCTURAL',
      findings: findings.map((finding) => ({ ...finding, patched: false })),
      recommendations: [...new Set(recommendations)],
      unfixableReason: 'The generated patch did not apply to the file it was generated from.',
      assertionsBefore: check.assertionsBefore,
      assertionsAfter: check.assertionsAfter,
      dialect,
    };
  }

  const patched = findings.filter((finding) => finding.patched);
  const described = findings.filter((finding) => !finding.patched);

  return {
    fixable: true,
    diff,
    explanation:
      `Deflake, derived with no model call: ${patched
        .map((finding) => `line ${finding.line} — ${finding.repair}`)
        .join(' ')}` +
      (described.length > 0
        ? ` ${described.length} further reason${described.length === 1 ? '' : 's'} this test is ` +
          `unreliable ${described.length === 1 ? 'is' : 'are'} reported and NOT patched, because ` +
          `${described.length === 1 ? 'it is' : 'they are'} a decision rather than a substitution — ` +
          `see the findings.`
        : '') +
      ` No assertion was removed or loosened: the test asserted ${check.assertionsBefore} thing(s) ` +
      `before and ${check.assertionsAfter} after.`,
    confidence: Math.min(...appliedConfidences),
    riskLevel: 'STRUCTURAL',
    findings,
    recommendations: [...new Set(recommendations)],
    unfixableReason: null,
    assertionsBefore: check.assertionsBefore,
    assertionsAfter: check.assertionsAfter,
    dialect,
  };
}

function unfixableReason(
  findings: readonly DeflakeFinding[],
  unreliable: boolean,
  playwright: boolean,
  dialect: DialectId | null,
): string {
  if (unreliable) {
    return "QAAI could not read this test reliably — the source ends inside a string or a comment — so nothing was scanned and nothing is claimed. This is not a clean bill of health.";
  }
  if (findings.length === 0) {
    return playwright
      ? 'None of the deterministic flake patterns QAAI can detect are present in this test: no fixed sleep, no un-awaited action, no eager read, no shared fixture, no random or clock-derived data. The instability is somewhere QAAI cannot see from the source alone — the application, the environment, or test ordering — so this needs a human or a model with the failure artefacts in hand.'
      : `QAAI detects flake patterns in every language it has a lexicon for, and found none here${dialect ? ` (read as ${dialect})` : ' — and it has no lexicon for this file type, so the scan itself proves nothing'}.`;
  }
  return playwright
    ? 'Every reason this test is unreliable is a decision rather than a substitution, so there is nothing to apply automatically. The findings name each repair.'
    : 'QAAI can detect these patterns in this language but only rewrites Playwright/JavaScript, so the repairs are described rather than applied.';
}

function explainUnfixable(
  input: DeflakeInput,
  findings: readonly DeflakeFinding[],
  unreliable: boolean,
  playwright: boolean,
  dialect: DialectId | null,
): string {
  const measured = input.evidence?.measured;
  const lead = measured
    ? `"${input.testName}" failed ${measured.failed} of ${measured.of} confirmation re-runs. `
    : `"${input.testName}" was triaged as a flake. `;
  return (
    lead +
    (findings.length === 0
      ? `QAAI has no fix to propose and is saying so rather than filing an empty one. ${unfixableReason(findings, unreliable, playwright, dialect)}`
      : `QAAI found ${findings.length} reason${findings.length === 1 ? '' : 's'} for it and cannot patch ${findings.length === 1 ? 'it' : 'any of them'} automatically. ${unfixableReason(findings, unreliable, playwright, dialect)}`)
  );
}
