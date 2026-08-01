/**
 * Suite health — what a test suite is actually worth, measured from what its
 * tests DO.
 *
 * Suites rot by accretion. Somebody copies the checkout spec to cover a coupon
 * case, deletes one assertion, and now two tests navigate the same five pages
 * to prove almost the same thing. Somebody else writes a smoke test that goes
 * to /orders and asserts the response was 200 — which it would be if the page
 * rendered an empty div and a stack trace. Nothing in this product has ever
 * said either of those things out loud, so the suite gets slower and weaker at
 * the same time while the number on the dashboard keeps going up.
 *
 * Two rules govern everything below.
 *
 * ONE: nothing here deletes anything, and nothing here is allowed to say that
 * deleting something is safe. A "duplicate" that differs in one assertion is
 * frequently the only test that catches a regression, and a test is not
 * recoverable once it is gone. So duplicates are reported as pairs with the
 * SHARED and the DIFFERING parts spelled out, and the recommendation is always
 * that a human read them. `safeToDelete` is a field, and it is always false.
 *
 * TWO: absence of evidence is never evidence of absence. Every cap in here —
 * code length, token count, pair count — protects the server by throwing away
 * part of what a test says. A finding like "this test has no assertions" is a
 * statement about the WHOLE test, so it is only ever emitted for a test we read
 * end to end. Anything we could not read completely lands in `unanalyzed` with
 * a reason instead of being quietly scored as healthy, and a scan that hit its
 * cap says so rather than presenting a shorter list as if it were the answer.
 *
 * The analysis is string-and-offset level, not AST level, for the same reason
 * impact analysis is: the `code` column holds whatever the generator, the
 * importer, or a human last wrote — including files that do not parse — and a
 * parser that throws on one test would take the whole report down with it.
 * Comments ARE stripped first, though: a commented-out `expect()` counting as
 * an assertion would hide exactly the finding this module exists to make.
 *
 * No model is called from this file. Everything here is deterministic and
 * testable without an API key; `suiteHealthPrompt()` exists so a model can
 * later narrate a report it did not produce.
 */

import type { Priority, TestType } from '@qaai/shared';

// ─── Caps ────────────────────────────────────────────────────────────────────

/** Past this, a `code` blob is a generated artifact and scanning it is a DoS. */
export const MAX_CODE_CHARS = 400_000;

/** Per-test ceiling on extracted behaviour tokens. */
export const MAX_TOKENS_PER_TEST = 400;

/**
 * Pairwise comparison is quadratic. The inverted index below keeps the real
 * count far under this on any sane suite; the cap is what stops a suite where
 * every test does the same three things from pinning a CPU.
 *
 * Sized against the API's own per-request test cap (2000): a budget the
 * endpoint routinely exceeds is not a safety valve, it is a permanent
 * "duplicate detection unavailable" on every large project. Measured at ~600ms
 * for a full million comparisons on a deliberately homogeneous 2000-test suite,
 * which is the worst case and is acceptable for an on-demand analysis endpoint.
 */
export const MAX_PAIRS = 1_000_000;

/**
 * A behaviour token shared by more than this many tests carries no information
 * about any particular pair, and expanding its posting list alone costs
 * |list|²/2 comparisons — 11k at this limit, 125k at 500.
 */
export const MAX_POSTINGS = 150;

export const DEFAULT_MIN_SIMILARITY = 0.6;
export const DEFAULT_MAX_REPORTED_PAIRS = 100;
export const MAX_FINDINGS = 500;

/**
 * Clusters are capped for PAYLOAD only, after the score has been computed from
 * all of them. Truncating before scoring would let a suite improve its number
 * by having too many duplicates to list, which is the exact opposite of what
 * the number is for.
 */
export const MAX_REPORTED_CLUSTERS = 100;

/**
 * Below this many behaviour tokens, a similarity score is an artefact of having
 * nothing to compare. Two tests that each do one thing and that thing is
 * `goto('/')` are not duplicates; they are two tests that told us almost
 * nothing — which is a weak-assertion finding, not a duplication one.
 */
const MIN_TOKENS_FOR_COMPARISON = 3;

/** Quoted source lines are evidence, not a code listing. */
const MAX_QUOTE_CHARS = 200;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface SuiteHealthTestInput {
  id: string;
  name: string;
  filePath: string;
  type: TestType;
  priority: Priority;
  feature: string | null;
  tags: string[];
  /** Playwright/ecosystem source. Spec-driven types leave this inert or null. */
  code: string | null;
  /** Type-specific config; API steps, a11y routes, security paths live here. */
  spec: unknown;
  /** Flake radar (§5). `flakeRate` is a PERCENT, 0–100, as the run finaliser writes it. */
  flakeRate: number;
  quarantined: boolean;
  consecutiveFailures: number;
}

export interface SuiteHealthOptions {
  /** Pairs scoring below this are not reported. */
  minSimilarity?: number;
  maxReportedPairs?: number;
  maxPairs?: number;
  maxPostings?: number;
}

export interface SuiteHealthInput {
  tests: SuiteHealthTestInput[];
  /** Serialised FlowMap of the latest crawl; drives critical-path coverage. */
  flowMapGraph?: unknown;
  options?: SuiteHealthOptions;
}

// ─── Comment stripping ───────────────────────────────────────────────────────

interface StrippedSource {
  /** Same length and same line breaks as the input; comment bytes become spaces. */
  text: string;
  /**
   * True when the scan ended inside a string or a block comment. The stripping
   * is then untrustworthy, and every finding that argues from ABSENCE has to be
   * withheld for this test — see rule TWO at the top.
   */
  unreliable: boolean;
}

/**
 * Blank out comments while preserving offsets and line breaks, so a match index
 * still maps to the right line of the ORIGINAL source — which is what gets
 * quoted back to the user, comments and all, because they should recognise
 * what they wrote.
 *
 * String tracking is what makes this safe on real specs: `page.goto('https://x')`
 * would otherwise lose everything after the `//`, and a `/*` inside a selector
 * string would swallow the rest of the file.
 */
export function stripComments(source: string): StrippedSource {
  const out = source.split('');
  let i = 0;
  let quote: string | null = null;
  let inLine = false;
  let inBlock = false;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (inLine) {
      if (ch === '\n') inLine = false;
      else out[i] = ' ';
      i += 1;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        inBlock = false;
        i += 2;
        continue;
      }
      if (ch !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }

    if (quote) {
      // A backslash escapes the next byte, including the closing quote.
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      inBlock = true;
      i += 2;
      continue;
    }
    i += 1;
  }

  return { text: out.join(''), unreliable: inBlock || quote !== null };
}

// ─── Route normalisation ─────────────────────────────────────────────────────

/**
 * Collapse every framework's dynamic-segment spelling onto one: `:param`.
 * `/orders/[id]`, `/orders/{id}`, `/orders/:id` and `/orders/8123` all describe
 * the same route, and comparing them literally makes two tests that visit the
 * same page look unrelated.
 */
export function normalizeRoute(raw: string): string {
  const withoutQuery = raw.split('?')[0]!.split('#')[0]!;
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const s = segment.trim().toLowerCase();
      if (!s) return '';
      if (/^\[\[?\.\.\..+\]\]?$/.test(s) || s === '*' || s === '**') return '*';
      if (/^\[.+\]$/.test(s) || /^\{.+\}$/.test(s) || /^[:$].+/.test(s)) return ':param';
      // A bare numeric or uuid-shaped segment is an id: /orders/8123 and
      // /orders/9004 are the same route and must not read as two.
      if (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return ':param';
      return s;
    })
    .filter(Boolean);

  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

// ─── Small scanning helpers ──────────────────────────────────────────────────

/** Byte offset → 1-based line number, via a prefix table built once per test. */
function lineIndex(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function quoteLine(original: string, starts: number[], line: number): string {
  const start = starts[line - 1] ?? 0;
  const end = starts[line] ?? original.length;
  const text = original.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text;
}

/**
 * Walk forward from an opening paren to its match, honouring strings so a `)`
 * inside `getByRole('button', { name: 'Close )' })` does not end the call early.
 * Returns -1 when the source runs out, which happens on genuinely unbalanced
 * code and must not throw.
 */
function matchParen(source: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBrace(source: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The start of the statement containing `idx`. Locator chains routinely span
 * lines, so taking "the current line" would read
 * `await page\n  .getByRole('button')\n  .click()` as a click on nothing.
 *
 * The bracket depth is not decoration. `getByRole('button', { name: 'Pay' })`
 * puts a `}` immediately before the `.click()`, and a naive backward scan for
 * `;{}` stops there — leaving `).click()` as the statement and every role
 * locator in the suite reading as `unknown`.
 */
function statementStart(source: string, idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const ch = source[i]!;
    if (ch === ')' || ch === ']' || ch === '}') {
      depth += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      // An opener we never closed is the start of the enclosing call or block.
      if (depth === 0) return i + 1;
      depth -= 1;
      continue;
    }
    if (ch === ';' && depth === 0) return i + 1;
  }
  return 0;
}

/**
 * `const payButton = page.getByRole('button', { name: 'Pay' })` → the identity
 * of `payButton`, so a later `payButton.click()` is compared against the same
 * key a test that inlined the locator produces. Without this, extracting the
 * same journey from two differently-styled specs yields two disjoint action
 * sets and the duplicate never surfaces.
 */
function locatorBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;

  for (let m = re.exec(source); m; m = re.exec(source)) {
    const start = m.index + m[0].length;
    const semi = source.indexOf(';', start);
    const expr = source.slice(start, Math.min(semi === -1 ? source.length : semi, start + 300));
    const key = normalizeLocator(expr);
    if (key !== 'unknown' && !key.startsWith('var=')) bindings.set(m[1]!.toLowerCase(), key);
  }
  return bindings;
}

/** The first argument of a call, as written. `''` when there is no argument. */
function firstArg(source: string, openIdx: number, closeIdx: number): string {
  const inner = source.slice(openIdx + 1, closeIdx);
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return inner.slice(0, i).trim();
  }
  return inner.trim();
}

type ArgKind = 'string' | 'regex' | 'number' | 'expression' | 'none';

function classifyArg(arg: string): ArgKind {
  const a = arg.trim();
  if (!a) return 'none';
  if (/^['"`]/.test(a) && !a.includes('${')) return 'string';
  if (a.startsWith('/') && /\/[gimsuy]*$/.test(a) && a.length > 2) return 'regex';
  if (/^-?\d+(\.\d+)?$/.test(a)) return 'number';
  return 'expression';
}

function stringLiteralValue(arg: string): string | null {
  const m = /^(['"`])([\s\S]*)\1$/.exec(arg.trim());
  return m ? m[2]! : null;
}

// ─── Locators ────────────────────────────────────────────────────────────────

const LOCATOR_FACTORY =
  /\.(getByRole|getByLabel|getByLabelText|getByPlaceholder|getByText|getByTestId|getByAltText|getByTitle|getByDisplayValue|locator|frameLocator)\s*\(/g;

const LOCATOR_KEYS: Record<string, string> = {
  getByRole: 'role',
  getByLabel: 'label',
  getByLabelText: 'label',
  getByPlaceholder: 'placeholder',
  getByText: 'text',
  getByTestId: 'testid',
  getByAltText: 'alt',
  getByTitle: 'title',
  getByDisplayValue: 'value',
  locator: 'css',
  frameLocator: 'frame',
};

/** `{ name: 'Add to cart' }` → `add to cart`, so a role locator keeps its identity. */
function roleName(argsText: string): string | null {
  const m = /\bname\s*:\s*(['"`])([\s\S]*?)\1/.exec(argsText);
  if (m) return m[2]!.trim().toLowerCase();
  const rx = /\bname\s*:\s*\/([\s\S]*?)\/[gimsuy]*/.exec(argsText);
  return rx ? `/${rx[1]!.toLowerCase()}/` : null;
}

/**
 * A stable, comparable identity for whatever element a statement is talking
 * about. `page.getByRole('button', { name: 'Pay' }).first().click()` becomes
 * `role=button[pay]:first` — which two tests written by two people, one using
 * single quotes and one double, will agree on.
 */
export function normalizeLocator(statement: string): string {
  const parts: string[] = [];
  LOCATOR_FACTORY.lastIndex = 0;

  for (let m = LOCATOR_FACTORY.exec(statement); m; m = LOCATOR_FACTORY.exec(statement)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(statement, open);
    if (close === -1) break;
    const key = LOCATOR_KEYS[m[1]!] ?? m[1]!.toLowerCase();
    const argsText = statement.slice(open + 1, close);
    const rawFirst = firstArg(statement, open, close);
    const value = (stringLiteralValue(rawFirst) ?? rawFirst).trim().toLowerCase();
    const name = key === 'role' ? roleName(argsText) : null;
    parts.push(name ? `${key}=${value}[${name}]` : `${key}=${value}`);
    LOCATOR_FACTORY.lastIndex = close;
  }

  const modifiers: string[] = [];
  if (/\.first\s*\(\s*\)/.test(statement)) modifiers.push('first');
  if (/\.last\s*\(\s*\)/.test(statement)) modifiers.push('last');
  const nth = /\.nth\s*\(\s*(\d+)\s*\)/.exec(statement);
  if (nth) modifiers.push(`nth${nth[1]}`);
  const hasText = /\bhasText\s*:\s*(['"`])([\s\S]*?)\1/.exec(statement);
  if (hasText) modifiers.push(`has:${hasText[2]!.trim().toLowerCase()}`);

  if (parts.length === 0) {
    // No factory call: either the pre-locator API (`page.click('#pay')`) or a
    // variable holding a locator. Both still name *something*, and a name we
    // can compare beats dropping the action on the floor.
    const legacy = /\bpage\s*\.\s*(?:click|fill|type|press|check|hover|selectOption)\s*\(\s*(['"`])([^'"`]{1,120})\1/.exec(
      statement,
    );
    if (legacy) return `css=${legacy[2]!.trim().toLowerCase()}`;
    const bare = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:click|fill|type|press|check|hover)\s*\(/.exec(
      statement,
    );
    if (bare && bare[1] !== 'page') return `var=${bare[1]!.toLowerCase()}`;
    return 'unknown';
  }

  const key = parts.join('>');
  return modifiers.length > 0 ? `${key}:${modifiers.join(':')}` : key;
}

// ─── Behaviour extraction ────────────────────────────────────────────────────

export interface NavigationSite {
  line: number;
  route: string;
}

export interface ActionSite {
  line: number;
  verb: string;
  locator: string;
}

export type AssertionKind = 'existence' | 'content' | 'transport' | 'other';

export interface AssertionSite {
  line: number;
  /** The original source line, whitespace-collapsed. Evidence for a finding. */
  quote: string;
  /** What is being asserted about, normalised: a locator key or an expression. */
  target: string;
  matcher: string;
  negated: boolean;
  arg: string;
  argKind: ArgKind;
  kind: AssertionKind;
  /** True when the expected value will change between runs on its own. */
  volatile: boolean;
  volatileReason: string | null;
  /** True when this assertion sits in a try whose catch throws nothing. */
  swallowed: boolean;
  swallowLine: number | null;
}

export interface TestBehavior {
  testId: string;
  name: string;
  filePath: string;
  feature: string | null;
  priority: Priority;
  type: TestType;
  /** Sorted, de-duplicated behaviour tokens, one facet each. */
  routes: string[];
  actions: string[];
  assertions: string[];
  /** Literal test data (what got typed in). Weak evidence — reported, barely scored. */
  data: string[];
  navigationSites: NavigationSite[];
  actionSites: ActionSite[];
  assertionSites: AssertionSite[];
  /**
   * True when we did not read the whole test: oversized code, a cap tripped, or
   * comment stripping that ended mid-string. No absence-based finding may be
   * emitted for such a test, and it is not eligible for duplicate comparison.
   */
  incomplete: boolean;
  incompleteReason: string | null;
}

const NAVIGATION_CALL = /\.(goto|navigate)\s*\(/g;

const ACTION_CALL =
  /\.(click|dblclick|fill|type|press|check|uncheck|selectOption|setInputFiles|hover|dragTo|tap|focus|clear|selectText)\s*\(/g;

const VALUE_ACTIONS = new Set(['fill', 'type', 'press', 'selectoption']);

const EXPECT_CALL = /\bexpect(?:\.soft|\.poll)?\s*\(/g;

/**
 * Matchers that establish an element is THERE and nothing about what it says.
 *
 * `toBeHidden`, `toHaveCount` and `toBeNull` are deliberately NOT in here even
 * though they are shaped like existence checks. Each makes a definite claim
 * about state — "no error is showing", "there are exactly three rows", "the
 * error is null" — and there is no "assert the content instead" advice to give
 * about them. Flagging them was the fastest way to make this report noisy
 * enough that nobody reads it.
 */
const EXISTENCE_MATCHERS = new Set([
  'tobevisible',
  'tobeattached',
  'tobeinviewport',
  'tobedefined',
  'tobetruthy',
  'tobefalsy',
  'toexist',
]);

const TRANSPORT_MATCHERS = new Set([
  'tobeok',
  'tohaveurl',
  'tohavetitle',
  'tohavestatus',
  'toberedirect',
]);

const CONTENT_MATCHERS = new Set([
  'tohavetext',
  'tocontaintext',
  'tohavecount',
  'tobehidden',
  'tobenull',
  'tobeundefined',
  'tohavevalue',
  'tohavevalues',
  'tohaveattribute',
  'tohaveclass',
  'tohavecss',
  'tohaveid',
  'tohaveaccessiblename',
  'tohaveaccessibledescription',
  'tohaverole',
  'tobechecked',
  'tobeenabled',
  'tobedisabled',
  'tobeeditable',
  'tobeempty',
  'tobefocused',
  'tohavescreenshot',
  'tomatchsnapshot',
  'toequal',
  'tostrictequal',
  'tomatchobject',
  'tocontainequal',
  'tohaveproperty',
  'tomatch',
  'tobecloseto',
  'tobegreaterthan',
  'tobelessthan',
  'tobegreaterthanorequal',
  'tobelessthanorequal',
  'tohavelength',
  'tocontain',
]);

const STATUS_TARGET = /\bstatus\b|\bstatuscode\b|\bok\s*\(/i;

function classifyMatcher(matcher: string, target: string): AssertionKind {
  const m = matcher.toLowerCase();
  if (TRANSPORT_MATCHERS.has(m)) return 'transport';
  // `toBe`/`toEqual` are the shape-shifters: against `response.status()` they
  // are a transport check, against a total they are the strongest assertion in
  // the file. The target decides, not the matcher.
  if (m === 'tobe' || m === 'toequal' || m === 'tostrictequal') {
    return STATUS_TARGET.test(target) ? 'transport' : 'content';
  }
  if (EXISTENCE_MATCHERS.has(m)) return 'existence';
  if (CONTENT_MATCHERS.has(m)) return 'content';
  return 'other';
}

/**
 * Literal values that are different every run. A test asserting one of these
 * does not fail when the app breaks; it fails on Tuesday.
 */
const VOLATILE_LITERAL: Array<{ re: RegExp; why: string }> = [
  { re: /\d{4}-\d{2}-\d{2}/, why: 'an ISO date' },
  { re: /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/i, why: 'a clock time' },
  { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i, why: 'a UUID' },
  { re: /#\s*\d{3,}/, why: 'an order or invoice number' },
  { re: /\b\d{6,}\b/, why: 'a generated id' },
  {
    re: /\b(just now|an? (few )?(second|minute|hour)s? ago|\d+\s+(second|minute|hour|day)s? ago)\b/i,
    why: 'a relative timestamp',
  },
  {
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i,
    why: 'a formatted date',
  },
];

/** Expressions whose VALUE is regenerated on every run. */
const VOLATILE_EXPRESSION: Array<{ re: RegExp; why: string }> = [
  { re: /\bDate\.now\s*\(|new\s+Date\s*\(|Date\.parse\s*\(/, why: 'a clock read' },
  { re: /\.toLocale(Date|Time)?String\s*\(/, why: 'a locale-formatted clock read' },
  { re: /\bMath\.random\s*\(/, why: 'a random value' },
  { re: /\bfaker\./, why: 'a faker value' },
  { re: /\bnanoid\s*\(|\brandomUUID\s*\(|\buuidv?4?\s*\(/i, why: 'a generated id' },
  { re: /\bdayjs\s*\(|\bmoment\s*\(/, why: 'a clock read' },
];

/** Every quoted string inside a chunk of argument text, contents only. */
function stringLiteralsIn(text: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) {
        out.push(text.slice(start, i));
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      start = i + 1;
    }
  }
  return out;
}

/**
 * Volatility is judged over the WHOLE argument list, not the first argument:
 * `toHaveAttribute('href', '/orders/8812431')` puts the interesting half in
 * position two, and checking only position one would miss every one of them.
 *
 * A regex expected value is deliberately never flagged — it is the FIX for
 * volatility, not an instance of it — and it falls out for free, because a
 * regex literal is not a quoted string and so is never tested.
 */
function volatilityOf(argsText: string): string | null {
  if (!argsText.trim()) return null;
  for (const { re, why } of VOLATILE_EXPRESSION) if (re.test(argsText)) return why;
  for (const literal of stringLiteralsIn(argsText)) {
    for (const { re, why } of VOLATILE_LITERAL) if (re.test(literal)) return why;
  }
  return null;
}

/**
 * Ranges of try-blocks whose catch swallows.
 *
 * An assertion inside one of these cannot fail the test: Playwright's `expect`
 * throws, the catch eats it, and the run goes green over a broken app. This is
 * the single most dangerous shape in a suite, precisely because it reads like a
 * test that is being careful.
 */
function swallowingTryRanges(
  source: string,
): Array<{ start: number; end: number; catchAt: number }> {
  const ranges: Array<{ start: number; end: number; catchAt: number }> = [];
  const re = /\btry\s*\{/g;

  for (let m = re.exec(source); m; m = re.exec(source)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(source, open);
    if (close === -1) break;

    const after = source.slice(close + 1, close + 200);
    const catchMatch = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(after);
    if (!catchMatch) {
      re.lastIndex = close + 1;
      continue;
    }
    const catchOpen = close + 1 + catchMatch[0].length - 1;
    const catchClose = matchBrace(source, catchOpen);
    if (catchClose === -1) break;

    const body = source.slice(catchOpen + 1, catchClose);
    // A catch that re-throws, re-asserts, or fails the test is doing its job.
    const rethrows =
      /\bthrow\b|\bexpect\s*\(|\bfail\s*\(|\bt\.error\b|\bassert\b|test\.fail\s*\(/.test(body);
    if (!rethrows) ranges.push({ start: open, end: close, catchAt: catchOpen });

    re.lastIndex = close + 1;
  }
  return ranges;
}

/**
 * Routes buried in `spec`, for the test types whose `code` column is inert:
 * API steps carry `path`, accessibility carries `routes`, security carries
 * `authRequiredPaths`. Walked structurally rather than by key name because
 * those shapes are owned by the runner plugins and drift independently of this
 * file — a key allow-list would silently stop seeing a new plugin's routes.
 */
export function routesFromSpec(spec: unknown, depth = 0, out = new Set<string>()): string[] {
  if (depth > 6 || out.size >= 100) return [...out];

  if (typeof spec === 'string') {
    if (spec.startsWith('/')) out.add(normalizeRoute(spec));
    else if (/^https?:\/\//i.test(spec)) {
      try {
        out.add(normalizeRoute(new URL(spec).pathname));
      } catch {
        // Not a URL after all; it simply carries no route.
      }
    }
    return [...out];
  }
  if (Array.isArray(spec)) {
    for (const item of spec) routesFromSpec(item, depth + 1, out);
    return [...out];
  }
  if (spec && typeof spec === 'object') {
    for (const value of Object.values(spec)) routesFromSpec(value, depth + 1, out);
  }
  return [...out];
}

/**
 * Assertions declared in `spec` rather than in code. An API test whose spec
 * says `expectStatus: 200` and nothing else is exactly the "asserts only a
 * status code" case, and it has to be visible even though its `code` is inert.
 */
export function specAssertions(spec: unknown): {
  statusOnly: boolean;
  count: number;
  /** The fragment carrying the status check, for quoting back as evidence. */
  statusQuote: string | null;
} {
  let status = 0;
  let body = 0;
  let statusQuote: string | null = null;

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (/status/.test(k)) {
        status += 1;
        if (statusQuote === null) {
          statusQuote = `spec: ${JSON.stringify(node).slice(0, MAX_QUOTE_CHARS)}`;
        }
      } else if (
        /(expect|assert|schema|jsonpath|contains|match|equals|bodyincludes|threshold|violation)/.test(
          k,
        )
      ) {
        body += 1;
      }
      walk(value, depth + 1);
    }
  };

  walk(spec, 0);
  return { statusOnly: status > 0 && body === 0, count: status + body, statusQuote };
}

/**
 * Everything one test does, in a form two tests can be compared on.
 *
 * Never throws. A test whose code is unreadable comes back with empty facets
 * and `incomplete` set, which is what keeps it out of both the duplicate report
 * and the "this test asserts nothing" accusation.
 */
/**
 * Assertion tokens for a spec-driven test.
 *
 * Deliberately structural rather than a key allow-list: a new runner plugin
 * inventing its own expectation field keeps being seen, which is the same
 * reasoning `routesFromSpec` already follows. Values are folded in as well as
 * keys, because `status: 200` and `status: 404` are different behaviour and
 * collapsing them to "asserts status" would call them duplicates.
 */
const ASSERTION_KEY = /^(expect|expected|assert|status|statusCode|expectStatus|body|bodyMatches|bodyContains|contains|matches|equals|maxLatencyMs|threshold|thresholds|maxDiffRatio|minScore|rules|severity)$/i;

export function specBehaviorTokens(spec: unknown): string[] {
  const out = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    // The same depth guard routesFromSpec uses; a spec is config, not a graph.
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 100)) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (ASSERTION_KEY.test(key)) {
        const rendered =
          value === null || typeof value === 'object'
            ? Array.isArray(value)
              ? `[${value.length}]`
              : JSON.stringify(value)?.slice(0, 60) ?? 'object'
            : String(value).slice(0, 60);
        out.add(`spec:${key.toLowerCase()}:${rendered.toLowerCase()}`);
      }
      walk(value, depth + 1);
    }
  };

  walk(spec, 0);
  return [...out].sort();
}

export function extractBehavior(test: SuiteHealthTestInput): TestBehavior {
  const routes = new Set<string>();
  const actions = new Set<string>();
  const assertions = new Set<string>();
  const data = new Set<string>();
  const navigationSites: NavigationSite[] = [];
  const actionSites: ActionSite[] = [];
  const assertionSites: AssertionSite[] = [];

  let incomplete = false;
  const reasons: string[] = [];

  const rawCode = test.code ?? '';
  if (rawCode.length > MAX_CODE_CHARS) {
    incomplete = true;
    reasons.push(`code is ${rawCode.length} chars; only the first ${MAX_CODE_CHARS} were read`);
  }
  const original = rawCode.slice(0, MAX_CODE_CHARS);
  const stripped = stripComments(original);
  if (stripped.unreliable) {
    incomplete = true;
    reasons.push('source ends inside an unterminated string or comment, so it was not fully parsed');
  }

  const src = stripped.text;
  const starts = lineIndex(original);
  const bindings = locatorBindings(src);

  /** Turn `var=payButton` back into the locator that variable holds. */
  const resolveLocator = (key: string, expression: string): string => {
    if (key.startsWith('var=')) return bindings.get(key.slice(4)) ?? key;
    if (key === 'unknown') {
      const ident = /^([A-Za-z_$][\w$]*)$/.exec(expression.trim());
      const hit = ident ? bindings.get(ident[1]!.toLowerCase()) : undefined;
      if (hit) return hit;
    }
    return key;
  };

  const swallowRanges = swallowingTryRanges(src);
  const swallowAt = (idx: number): { swallowed: boolean; line: number | null } => {
    for (const range of swallowRanges) {
      if (idx > range.start && idx < range.end) {
        return { swallowed: true, line: lineOf(starts, range.catchAt) };
      }
    }
    return { swallowed: false, line: null };
  };

  const overflow = (): boolean => {
    if (routes.size + actions.size + assertions.size < MAX_TOKENS_PER_TEST) return false;
    if (!incomplete) reasons.push(`stopped after ${MAX_TOKENS_PER_TEST} behaviour tokens`);
    incomplete = true;
    return true;
  };

  // Navigation.
  NAVIGATION_CALL.lastIndex = 0;
  for (let m = NAVIGATION_CALL.exec(src); m; m = NAVIGATION_CALL.exec(src)) {
    if (overflow()) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close === -1) break;
    NAVIGATION_CALL.lastIndex = close;

    const arg = firstArg(src, open, close);
    const literal = stringLiteralValue(arg);
    if (literal === null) continue; // `page.goto(url)` names no route we can read.

    /*
     * Template literals are the normal spelling in generated specs:
     * `${baseURL}/orders/${id}`. Each interpolation becomes a dynamic segment,
     * which is exactly what it is — and a leading one is the base URL, so the
     * route starts at the first slash after it.
     */
    const interpolated = literal.includes('${');
    let path = interpolated ? literal.replace(/\$\{[^}]*\}/g, ':param') : literal;

    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname;
      } catch {
        continue;
      }
    }
    if (!path.startsWith('/') && interpolated) {
      const slash = path.indexOf('/');
      if (slash === -1) continue;
      path = path.slice(slash);
    }
    if (!path.startsWith('/')) continue;
    const route = normalizeRoute(path);
    routes.add(`nav:${route}`);
    navigationSites.push({ line: lineOf(starts, m.index), route });
  }

  // Actions.
  ACTION_CALL.lastIndex = 0;
  for (let m = ACTION_CALL.exec(src); m; m = ACTION_CALL.exec(src)) {
    if (overflow()) break;
    const verb = m[1]!.toLowerCase();
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close === -1) break;
    ACTION_CALL.lastIndex = close;

    const statement = src.slice(statementStart(src, m.index), close + 1);
    const locator = resolveLocator(normalizeLocator(statement), statement);
    actions.add(`act:${verb}:${locator}`);
    actionSites.push({ line: lineOf(starts, m.index), verb, locator });

    if (VALUE_ACTIONS.has(verb)) {
      const value = stringLiteralValue(firstArg(src, open, close));
      if (value !== null && value.length <= 80) data.add(`data:${verb}:${value.toLowerCase()}`);
    }
  }

  // Assertions. Scanned over the whole source rather than per line, because a
  // wrapped `await expect(...)\n  .toHaveText(...)` is the house style and a
  // line-local scan would see the expect and never the matcher.
  EXPECT_CALL.lastIndex = 0;
  for (let m = EXPECT_CALL.exec(src); m; m = EXPECT_CALL.exec(src)) {
    if (overflow()) break;
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close === -1) break;
    EXPECT_CALL.lastIndex = close;

    const targetExpr = src.slice(open + 1, close).trim();
    const tail = src.slice(close + 1, close + 400);
    const chain =
      /^\s*\.\s*(?:(not)\s*\.\s*)?(?:(?:resolves|rejects)\s*\.\s*(?:(not)\s*\.\s*)?)?([A-Za-z_$][\w$]*)\s*\(/.exec(
        tail,
      );
    if (!chain) continue;

    const negated = Boolean(chain[1] ?? chain[2]);
    const matcher = chain[3]!;
    const matcherOpen = close + 1 + chain[0].length - 1;
    const matcherClose = matchParen(src, matcherOpen);
    const argsText = matcherClose === -1 ? '' : src.slice(matcherOpen + 1, matcherClose);
    const arg = matcherClose === -1 ? '' : firstArg(src, matcherOpen, matcherClose);
    const argKind = classifyArg(arg);

    const locator = resolveLocator(normalizeLocator(targetExpr), targetExpr);
    const target = locator === 'unknown' ? targetExpr.replace(/\s+/g, ' ').slice(0, 80) : locator;
    const kind = classifyMatcher(matcher, targetExpr);
    const volatileReason = volatilityOf(argsText);
    const swallow = swallowAt(m.index);
    const line = lineOf(starts, m.index);

    assertionSites.push({
      line,
      quote: quoteLine(original, starts, line),
      target,
      matcher,
      negated,
      arg,
      argKind,
      kind,
      volatile: volatileReason !== null,
      volatileReason,
      swallowed: swallow.swallowed,
      swallowLine: swallow.line,
    });

    /*
     * The whole argument list goes into the token, not just the first argument:
     * `toHaveText('Total: $10')` and `toHaveText('Total: $99')` are different
     * assertions and must not collapse onto one another in the duplicate scan.
     *
     * Quote style is normalised for the opposite reason. Two engineers writing
     * the identical assertion, one in single quotes and one in double, produced
     * two tokens that shared nothing — so a copied test read as asserting
     * something entirely different from its original, and the duplicate the
     * whole feature exists to surface never surfaced.
     */
    const expected = argsText
      .replace(/['"`]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 60);
    assertions.add(
      `assert:${negated ? 'not.' : ''}${matcher.toLowerCase()}:${target}:${expected}`,
    );
  }

  /*
   * Spec-driven types: the whole behaviour lives in `spec`, not in `code`.
   *
   * Only the ROUTES were read here, and that was enough to make duplicate
   * detection blind to every API, accessibility, visual and load test in a
   * suite. One route token is one token; `MIN_TOKENS_FOR_COMPARISON` is 3; so
   * each spec-driven test was dropped before any pair was formed.
   *
   * Measured on the seeded project: three byte-identical `GET /__health` tests
   * were reported as zero duplicates with a perfect 100/100 duplication score,
   * and only 2 of the 45 possible pairs were ever compared. The tests most
   * likely to be accidental copies — a bare API check someone imported three
   * times — were exactly the ones the comparison could not see.
   */
  for (const route of routesFromSpec(test.spec)) routes.add(`nav:${route}`);
  for (const token of specBehaviorTokens(test.spec)) assertions.add(token);

  if (incomplete && reasons.length === 0) reasons.push('analysis was truncated');

  return {
    testId: test.id,
    name: test.name,
    filePath: test.filePath,
    feature: test.feature,
    priority: test.priority,
    type: test.type,
    routes: [...routes].sort(),
    actions: [...actions].sort(),
    assertions: [...assertions].sort(),
    data: [...data].sort(),
    navigationSites,
    actionSites,
    assertionSites,
    incomplete,
    incompleteReason: incomplete ? reasons.join('; ') : null,
  };
}

// ─── Similarity ──────────────────────────────────────────────────────────────

export interface FacetComparison {
  /** Jaccard over this facet, or null when neither test has anything here. */
  score: number | null;
  shared: string[];
  onlyInA: string[];
  onlyInB: string[];
}

export interface SimilarityResult {
  score: number;
  facets: {
    routes: FacetComparison;
    actions: FacetComparison;
    assertions: FacetComparison;
    data: FacetComparison;
  };
  /** Facets where the two tests agree completely. */
  identicalFacets: string[];
  /** Facets where they do not. This is the column a human reads first. */
  differingFacets: string[];
}

/**
 * Facet weights. Assertions dominate ON PURPOSE.
 *
 * Two tests that click through the same five pages and then check different
 * things are two tests, not one — the second exists because somebody needed a
 * different guarantee. Weighting navigation and actions equally with assertions
 * is how a tool ends up recommending you delete the only test that checks the
 * total.
 */
const FACET_WEIGHTS = { routes: 0.25, actions: 0.25, assertions: 0.45, data: 0.05 } as const;

function compareFacet(a: string[], b: string[]): FacetComparison {
  const setA = new Set(a);
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t));
  const onlyInA = a.filter((t) => !setB.has(t));
  const onlyInB = b.filter((t) => !setA.has(t));
  const union = shared.length + onlyInA.length + onlyInB.length;
  return { score: union === 0 ? null : shared.length / union, shared, onlyInA, onlyInB };
}

export function similarity(a: TestBehavior, b: TestBehavior): SimilarityResult {
  const facets = {
    routes: compareFacet(a.routes, b.routes),
    actions: compareFacet(a.actions, b.actions),
    assertions: compareFacet(a.assertions, b.assertions),
    data: compareFacet(a.data, b.data),
  };

  let weighted = 0;
  let totalWeight = 0;
  const identicalFacets: string[] = [];
  const differingFacets: string[] = [];

  for (const key of ['routes', 'actions', 'assertions', 'data'] as const) {
    const comparison = facets[key];
    // A facet neither test uses says nothing either way and is left out of the
    // average — otherwise two tests with no assertions would score 1.0 on
    // "assertions" and read as certain duplicates on the strength of a shared
    // emptiness.
    if (comparison.score === null) continue;
    weighted += FACET_WEIGHTS[key] * comparison.score;
    totalWeight += FACET_WEIGHTS[key];
    if (comparison.score === 1) identicalFacets.push(key);
    else differingFacets.push(key);
  }

  return {
    score: totalWeight === 0 ? 0 : weighted / totalWeight,
    facets,
    identicalFacets,
    differingFacets,
  };
}

// ─── Duplicates ──────────────────────────────────────────────────────────────

export type DuplicateVerdict = 'IDENTICAL' | 'NEAR_DUPLICATE' | 'OVERLAPPING';

export interface DuplicateRef {
  testId: string;
  name: string;
  filePath: string;
  feature: string | null;
  priority: Priority;
}

export interface DuplicatePair {
  a: DuplicateRef;
  b: DuplicateRef;
  /** 0–1, rounded to three places. */
  score: number;
  verdict: DuplicateVerdict;
  facets: SimilarityResult['facets'];
  identicalFacets: string[];
  differingFacets: string[];
  /** True when the two tests check different things — the reason to keep both. */
  assertionsDiffer: boolean;
  /** Always false. Nothing in this module can establish that a test is disposable. */
  safeToDelete: false;
  /** What a human should actually do, in one sentence. */
  recommendation: string;
}

export interface DuplicateCluster {
  /** Tests transitively linked by IDENTICAL/NEAR_DUPLICATE pairs. */
  testIds: string[];
  size: number;
  members: DuplicateRef[];
  /** Behaviour every member shares. */
  sharedRoutes: string[];
  sharedActions: string[];
  sharedAssertions: string[];
  /** True when at least one member asserts something the others do not. */
  membersDiffer: boolean;
  recommendation: string;
}

function refOf(b: TestBehavior): DuplicateRef {
  return {
    testId: b.testId,
    name: b.name,
    filePath: b.filePath,
    feature: b.feature,
    priority: b.priority,
  };
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface DuplicateScan {
  pairs: DuplicatePair[];
  clusters: DuplicateCluster[];
  /**
   * False when a cap was hit. A shorter list is then NOT the answer, and the
   * score refuses to grade duplication off it — see `scoreSuiteHealth`.
   */
  complete: boolean;
  incompleteReason: string | null;
  pairsCompared: number;
  /** Reported rather than hidden: these tokens were too common to expand. */
  skippedCommonTokens: string[];
  /** How many qualifying pairs existed beyond `maxReportedPairs`. */
  omittedPairs: number;
  /**
   * Tests that were never eligible to be compared, and why.
   *
   * Reported rather than silently excluded: a suite of spec-driven API tests
   * would otherwise get "no duplication, scan complete" over a comparison that
   * never included them.
   */
  ineligible: Array<{ testId: string; name: string; reason: string }>;
}

export function findDuplicates(
  behaviors: TestBehavior[],
  options: SuiteHealthOptions = {},
): DuplicateScan {
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const maxReported = options.maxReportedPairs ?? DEFAULT_MAX_REPORTED_PAIRS;
  const maxPairs = options.maxPairs ?? MAX_PAIRS;
  const maxPostings = options.maxPostings ?? MAX_POSTINGS;

  /*
   * A test we could not read completely is not eligible. Its facets are a
   * subset of what it really does, and a subset can only make two tests look
   * MORE alike than they are — the wrong direction to be wrong in when the
   * output is "these two look redundant".
   */
  const eligible = behaviors.filter(
    (b) =>
      !b.incomplete &&
      b.routes.length + b.actions.length + b.assertions.length >= MIN_TOKENS_FOR_COMPARISON,
  );

  /*
   * Who was NOT eligible, and why.
   *
   * `complete` used to be computed from the safety caps alone, so a suite where
   * this filter dropped half the tests still reported `duplicateScanComplete:
   * true`, `omittedPairs: 0` and `unanalyzed: []`. That is worse than a low
   * score: it is a confident "no duplication here" over a comparison that
   * barely ran, and duplication carries a fifth of the composite.
   */
  const ineligible = behaviors
    .filter((b) => !eligible.includes(b))
    .map((b) => ({
      testId: b.testId,
      name: b.name,
      reason: b.incomplete
        ? (b.incompleteReason ?? 'the source could not be fully parsed')
        : `only ${b.routes.length + b.actions.length + b.assertions.length} behaviour token(s) could be read; ` +
          `${MIN_TOKENS_FOR_COMPARISON} are needed before two tests can be meaningfully compared`,
    }));

  /*
   * Candidate generation indexes on ACTIONS AND ASSERTIONS, not on routes.
   *
   * A route is the least discriminating thing a test declares — in a 2000-test
   * suite covering eight features, `nav:/checkout` alone yields 31k candidate
   * pairs and contributes nothing to telling any of them apart. Indexing routes
   * put the pair count over a million on an ordinary suite, which turned the
   * safety cap into a permanent "duplicate detection unavailable".
   *
   * Routes are still indexed for a test that has NOTHING else — routes are then
   * the only signal it has, and dropping it would make a set of thin,
   * navigation-only duplicates the one kind this cannot see.
   */
  const index = new Map<string, number[]>();
  eligible.forEach((behavior, i) => {
    const discriminating =
      behavior.actions.length + behavior.assertions.length > 0
        ? [...behavior.actions, ...behavior.assertions]
        : behavior.routes;
    for (const token of discriminating) {
      const list = index.get(token);
      if (list) list.push(i);
      else index.set(token, [i]);
    }
  });

  const candidates = new Set<number>();
  const skippedCommonTokens: string[] = [];
  let capped = false;
  const width = Math.max(1, eligible.length);

  outer: for (const [token, list] of index) {
    if (list.length > maxPostings) {
      skippedCommonTokens.push(token);
      continue;
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        candidates.add(list[i]! * width + list[j]!);
        if (candidates.size >= maxPairs) {
          capped = true;
          break outer;
        }
      }
    }
  }

  const scored: Array<{ pair: DuplicatePair; score: number }> = [];
  for (const key of candidates) {
    const a = eligible[Math.floor(key / width)]!;
    const b = eligible[key % width]!;
    const result = similarity(a, b);
    if (result.score < minSimilarity) continue;

    const assertionsDiffer =
      result.facets.assertions.onlyInA.length > 0 || result.facets.assertions.onlyInB.length > 0;

    /*
     * IDENTICAL means every facet both tests actually use agrees completely.
     * It is stated separately from the 0.85 threshold because "these two are
     * the same test twice" and "these two are 87% alike" call for different
     * conversations, and a weighted average cannot tell them apart.
     */
    const verdict: DuplicateVerdict =
      result.differingFacets.length === 0 && result.identicalFacets.length > 0
        ? 'IDENTICAL'
        : result.score >= 0.85
          ? 'NEAR_DUPLICATE'
          : 'OVERLAPPING';

    scored.push({
      score: result.score,
      pair: {
        a: refOf(a),
        b: refOf(b),
        score: round(result.score),
        verdict,
        facets: result.facets,
        identicalFacets: result.identicalFacets,
        differingFacets: result.differingFacets,
        assertionsDiffer,
        safeToDelete: false,
        recommendation: assertionsDiffer
          ? `Keep both until someone reads them. They differ on ${
              result.facets.assertions.onlyInA.length + result.facets.assertions.onlyInB.length
            } assertion(s), and a differing assertion is usually the whole reason the second test exists.`
          : verdict === 'IDENTICAL'
            ? 'These exercise the same routes, take the same actions and make the same assertions. Have the owner confirm nothing environmental differs (auth profile, fixtures, browser project) before folding one into the other.'
            : 'Substantially the same journey. Worth deciding whether one can absorb the other, or whether the difference should be made explicit in the names.',
      },
    });
  }

  scored.sort((x, y) => y.score - x.score);
  const pairs = scored.slice(0, maxReported).map((s) => s.pair);

  return {
    pairs,
    clusters: clusterDuplicates(
      scored.map((s) => s.pair),
      eligible,
    ),
    // Honest completeness: the caps AND the eligibility filter. A test that was
    // never eligible was never compared, and saying otherwise is the failure
    // mode this field exists to prevent.
    complete: !capped && skippedCommonTokens.length === 0 && ineligible.length === 0,
    ineligible,
    incompleteReason: capped
      ? `the pair scan stopped at ${maxPairs} candidate comparisons`
      : skippedCommonTokens.length > 0
        ? `${skippedCommonTokens.length} behaviour token(s) are shared by more than ${maxPostings} tests and were not expanded`
        : null,
    pairsCompared: candidates.size,
    skippedCommonTokens: skippedCommonTokens.slice(0, 20),
    omittedPairs: Math.max(0, scored.length - pairs.length),
  };
}

/**
 * "You have three tests doing the same thing" — the question a person actually
 * asks. Union-find over the strong pairs only; OVERLAPPING is a hint, not a
 * claim, and chaining hints transitively would merge a whole feature into one
 * cluster and prove nothing.
 */
function clusterDuplicates(pairs: DuplicatePair[], behaviors: TestBehavior[]): DuplicateCluster[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    for (;;) {
      const up = parent.get(root);
      if (up === undefined || up === root) return root;
      root = up;
    }
  };
  const union = (x: string, y: string): void => {
    parent.set(find(x), find(y));
  };

  for (const pair of pairs) {
    if (pair.verdict === 'OVERLAPPING') continue;
    if (!parent.has(pair.a.testId)) parent.set(pair.a.testId, pair.a.testId);
    if (!parent.has(pair.b.testId)) parent.set(pair.b.testId, pair.b.testId);
    union(pair.a.testId, pair.b.testId);
  }

  const groups = new Map<string, string[]>();
  for (const testId of parent.keys()) {
    const root = find(testId);
    const list = groups.get(root);
    if (list) list.push(testId);
    else groups.set(root, [testId]);
  }

  const byId = new Map(behaviors.map((b) => [b.testId, b]));
  const clusters: DuplicateCluster[] = [];

  for (const testIds of groups.values()) {
    const members = testIds.map((id) => byId.get(id)).filter((b): b is TestBehavior => Boolean(b));
    if (members.length < 2) continue;

    const intersect = (pick: (b: TestBehavior) => string[]): string[] =>
      members
        .slice(1)
        .reduce<string[]>((acc, member) => {
          const has = new Set(pick(member));
          return acc.filter((t) => has.has(t));
        }, pick(members[0]!));

    const sharedAssertions = intersect((b) => b.assertions);
    const membersDiffer = members.some((m) => m.assertions.length !== sharedAssertions.length);

    clusters.push({
      testIds: members.map((m) => m.testId),
      size: members.length,
      members: members.map(refOf),
      sharedRoutes: intersect((b) => b.routes),
      sharedActions: intersect((b) => b.actions),
      sharedAssertions,
      membersDiffer,
      recommendation: membersDiffer
        ? `${members.length} tests cover the same ground but do not all assert the same things. Read the differing assertions before touching any of them.`
        : `${members.length} tests cover the same ground with the same assertions. A human should decide which one survives — this tool will not.`,
    });
  }

  return clusters.sort((a, b) => b.size - a.size);
}

// ─── Weak assertions ─────────────────────────────────────────────────────────

export type WeakAssertionKind =
  | 'NO_ASSERTIONS'
  | 'TRANSPORT_ONLY'
  | 'EXISTENCE_ONLY'
  | 'VOLATILE_ASSERTION'
  | 'SWALLOWED_ASSERTION'
  | 'NO_NEGATIVE_PATH';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface WeakAssertion {
  kind: WeakAssertionKind;
  severity: Severity;
  testId: string;
  testName: string;
  filePath: string;
  feature: string | null;
  /** 1-based line in the test's own `code`. */
  line: number | null;
  /** The actual source line, so the finding can be checked without opening the file. */
  quote: string;
  why: string;
  /** Concrete: what to assert instead. */
  assertInstead: string;
}

const SEVERITY_DEMERIT: Record<Severity, number> = { HIGH: 1, MEDIUM: 0.5, LOW: 0.25 };

/** Test types where an "error path" is not a shape the test type has. */
const NO_NEGATIVE_PATH_TYPES = new Set<TestType>(['VISUAL', 'LOAD', 'ACCESSIBILITY']);

/**
 * Types whose pass/fail criterion lives in the runner plugin, not in the test.
 *
 * An accessibility test declares routes and the plugin runs axe against them; a
 * visual test declares a viewport and the plugin diffs pixels; a security smoke
 * test declares paths and the plugin probes them. None of these authors an
 * assertion, and none of them ever will — so "this test has no assertions" is
 * not a defect report about them, it is the report being wrong out loud. Every
 * one of the a11y and security rows in the seeded project was accused of it
 * before this set existed, which is enough noise to get the whole page ignored.
 */
const PLUGIN_ASSERTED_TYPES = new Set<TestType>([
  'ACCESSIBILITY',
  'VISUAL',
  'SECURITY_SMOKE',
  'MUTATION',
]);

/**
 * True when the locator itself pins the content, so `toBeVisible()` on it is a
 * real assertion rather than a placeholder.
 *
 * `getByRole('heading', { name: 'Products' })` fails if the heading says
 * anything else — the expected text is in the locator. Telling its author to
 * "assert the content instead" is advice to write the same assertion twice.
 * `getByTestId('product-price')` pins nothing: that element can render "NaN"
 * and the test still passes, which is the case worth reporting.
 */
function locatorPinsContent(target: string): boolean {
  if (/\[[^\]]+\]/.test(target)) return true; // role=button[pay now]
  if (/(^|>)(text|label|placeholder|alt|title|value)=/.test(target)) return true;
  return target.includes(':has:');
}

const NEGATIVE_NAME =
  /\b(invalid|error|fails?|failed|failure|denied|unauthori[sz]ed|forbidden|reject(ed|s)?|missing|empty|negative|wrong|bad|duplicate|expired|conflict|not[- ]?found|400|401|403|404|409|422|429|5\d\d)\b/i;
const ERROR_UI = /alert|error|invalid|danger|warning|toast|validation|required/i;
const ERROR_TEXT =
  /error|invalid|required|must be|cannot|can't|denied|failed|try again|not found|unauthori[sz]ed/i;

/**
 * The line a finding points at, and the text of it.
 *
 * Falls back through navigation → action → the first line, and finally to the
 * routes the test declares. That last rung is not decoration: a spec-driven
 * test has no source line at all, and a finding whose evidence field renders as
 * an empty string is a finding nobody can check.
 */
function anchorSite(behavior: TestBehavior, code: string): { line: number | null; quote: string } {
  const starts = lineIndex(code);
  const nav = behavior.navigationSites[0];
  if (nav) return { line: nav.line, quote: quoteLine(code, starts, nav.line) };
  const action = behavior.actionSites[0];
  if (action) return { line: action.line, quote: quoteLine(code, starts, action.line) };

  const firstLine = quoteLine(code, starts, 1);
  if (firstLine !== '') return { line: 1, quote: firstLine };
  return {
    line: null,
    quote:
      behavior.routes.length > 0
        ? `spec covers ${behavior.routes.map((r) => r.slice('nav:'.length)).join(', ')}`
        : '(this test declares no routes, actions or assertions we could read)',
  };
}

/** Does this test exercise an error path at all? */
function hasNegativeSignal(test: SuiteHealthTestInput, behavior: TestBehavior): boolean {
  if (NEGATIVE_NAME.test(test.name)) return true;
  if (test.tags.some((tag) => NEGATIVE_NAME.test(tag))) return true;

  for (const site of behavior.assertionSites) {
    if (site.negated) return true;
    const matcher = site.matcher.toLowerCase();
    if (matcher === 'tobehidden') return true;
    if (matcher === 'tohavecount' && site.arg.trim() === '0') return true;
    if (ERROR_UI.test(site.target)) return true;
    if (site.kind === 'transport' && /\b[45]\d\d\b/.test(site.arg)) return true;
    const literal = stringLiteralValue(site.arg);
    if (literal && ERROR_TEXT.test(literal)) return true;
  }
  return false;
}

function groupKeyFor(test: SuiteHealthTestInput): string {
  if (test.feature) return test.feature;
  const dir = test.filePath.split('/').slice(0, -1).join('/');
  return dir === '' ? '(ungrouped)' : dir;
}

export function findWeakAssertions(
  tests: SuiteHealthTestInput[],
  behaviors: Map<string, TestBehavior>,
): WeakAssertion[] {
  const findings: WeakAssertion[] = [];

  for (const test of tests) {
    const behavior = behaviors.get(test.id);
    if (!behavior) continue;
    const code = (test.code ?? '').slice(0, MAX_CODE_CHARS);

    /*
     * Swallowed assertions and volatile expected values are things we POSITIVELY
     * SAW, not conclusions drawn from absence, so they are emitted even for a
     * test we could not read to the end.
     */
    for (const site of behavior.assertionSites) {
      if (!site.swallowed) continue;
      findings.push({
        kind: 'SWALLOWED_ASSERTION',
        severity: 'HIGH',
        testId: test.id,
        testName: test.name,
        filePath: test.filePath,
        feature: test.feature,
        line: site.line,
        quote: site.quote,
        why: `This assertion is inside a try whose catch (line ${site.swallowLine ?? '?'}) neither re-throws nor fails the test. When it fails, the failure is caught and discarded and the test still passes — the app can break here and the suite stays green.`,
        assertInstead:
          'Delete the try/catch and let the assertion throw. If the block genuinely has to tolerate one specific error, catch that error by name and re-throw everything else, or assert on it directly with `await expect(promise).rejects.toThrow(/…/)`.',
      });
    }

    for (const site of behavior.assertionSites) {
      if (!site.volatile) continue;
      findings.push({
        kind: 'VOLATILE_ASSERTION',
        severity: 'MEDIUM',
        testId: test.id,
        testName: test.name,
        filePath: test.filePath,
        feature: test.feature,
        line: site.line,
        quote: site.quote,
        why: `The expected value is ${site.volatileReason}. It changes on its own between runs, so this assertion fails on a day nothing was deployed — and once it has cried wolf twice, the next real failure gets ignored.`,
        assertInstead:
          site.argKind === 'string'
            ? 'Assert the shape, not the instance: pass a regex (`toHaveText(/Order #\\d+/)`), or read the value the app generated and compare it to the one it should have derived. If the exact value matters, freeze the clock or the ids with a fixture or a route mock.'
            : 'Compute the expected value from the same fixed input the app used, or freeze the clock (`page.clock`) instead of comparing against a value generated at assert time.',
      });
    }

    // Everything past this point argues from ABSENCE, and absence is only
    // admissible when the whole test was read. Rule TWO at the top of the file.
    if (behavior.incomplete) continue;

    const substantive = behavior.assertionSites.filter((s) => !s.swallowed);

    if (behavior.assertionSites.length === 0 && !PLUGIN_ASSERTED_TYPES.has(test.type)) {
      // Nothing in `code`. For spec-driven types the assertions live in `spec`,
      // so the accusation has to be checked there before it is made.
      const spec = specAssertions(test.spec);
      const anchor = anchorSite(behavior, code);
      if (spec.count === 0) {
        findings.push({
          kind: 'NO_ASSERTIONS',
          severity: 'HIGH',
          testId: test.id,
          testName: test.name,
          filePath: test.filePath,
          feature: test.feature,
          line: anchor.line,
          quote: anchor.quote,
          why: 'This test makes no assertion anywhere. It passes as long as nothing throws, which means it reports green on a page that rendered an error state, an empty list, or a spinner that never resolved.',
          assertInstead:
            'Assert the outcome the user came for: the specific text, value or count that proves the action worked — e.g. `await expect(page.getByRole("heading")).toHaveText("Order confirmed")` rather than merely reaching the page.',
        });
      } else if (spec.statusOnly) {
        findings.push({
          kind: 'TRANSPORT_ONLY',
          severity: 'HIGH',
          testId: test.id,
          testName: test.name,
          filePath: test.filePath,
          feature: test.feature,
          // There is no source line to point at — the assertion is a spec key —
          // so the spec fragment is quoted instead of a comment in a dead file.
          line: null,
          quote: spec.statusQuote ?? anchor.quote,
          why: "The spec for this test checks a status code and nothing about the response body. A handler that returns 200 with an empty object, a stale cache, or someone else's data passes it.",
          assertInstead:
            'Add body assertions to the spec: the fields that must be present, their types, and at least one value the caller actually depends on (the id echoed back, the total, the status field).',
        });
      }
    } else if (substantive.length > 0 && substantive.every((s) => s.kind === 'transport')) {
      const site = substantive[0]!;
      findings.push({
        kind: 'TRANSPORT_ONLY',
        severity: 'HIGH',
        testId: test.id,
        testName: test.name,
        filePath: test.filePath,
        feature: test.feature,
        line: site.line,
        quote: site.quote,
        why: `Every assertion in this test is about the transport — a status code, a URL, or a title. ${
          behavior.navigationSites.length > 0 ? 'It navigates and then checks only that it arrived. ' : ''
        }A page that loads and renders an error, an empty state, or a spinner passes this test.`,
        assertInstead:
          'Keep the status/URL check as a precondition and add at least one assertion about content: `toHaveText`, `toContainText`, `toHaveValue`, or a count that must be non-zero. Assert the thing whose absence would mean the feature is broken.',
      });
    } else {
      // A locator that is only ever asserted to exist.
      const contentTargets = new Set(
        substantive.filter((s) => s.kind === 'content').map((s) => s.target),
      );
      const seen = new Set<string>();
      for (const site of substantive) {
        if (site.kind !== 'existence') continue;
        // A negated existence check IS a real assertion about state ("the error
        // is gone", "the row was deleted"), not a placeholder.
        if (site.negated) continue;
        // Nor is it a placeholder when the locator already names the text.
        if (locatorPinsContent(site.target)) continue;
        if (contentTargets.has(site.target) || seen.has(site.target)) continue;
        seen.add(site.target);
        findings.push({
          kind: 'EXISTENCE_ONLY',
          severity: 'MEDIUM',
          testId: test.id,
          testName: test.name,
          filePath: test.filePath,
          feature: test.feature,
          line: site.line,
          quote: site.quote,
          why: `\`${site.target}\` is only ever asserted to exist — nothing in this test checks what it contains. That element can render the wrong name, the wrong total, or the string "undefined", and this test still passes.`,
          assertInstead: `Assert the content of that element: \`await expect(<locator>).toHaveText(…)\` / \`.toContainText(…)\` / \`.toHaveValue(…)\`. Keep \`${site.matcher}\` as the wait, not as the verification.`,
        });
      }
    }
  }

  // Feature-level: no error path anywhere in the feature.
  const groups = new Map<string, SuiteHealthTestInput[]>();
  for (const test of tests) {
    if (NO_NEGATIVE_PATH_TYPES.has(test.type)) continue;
    const behavior = behaviors.get(test.id);
    // A feature whose tests we could not read cannot be declared error-path-free.
    if (!behavior || behavior.incomplete) continue;
    const key = groupKeyFor(test);
    const list = groups.get(key);
    if (list) list.push(test);
    else groups.set(key, [test]);
  }

  for (const [key, group] of groups) {
    if (group.some((test) => hasNegativeSignal(test, behaviors.get(test.id)!))) continue;
    // Anchor on a member that has a real source line, so the finding quotes
    // code rather than whatever happened to be on line 1 of a spec-driven test.
    const anchor =
      group.find((test) => {
        const b = behaviors.get(test.id)!;
        return b.navigationSites.length > 0 || b.actionSites.length > 0;
      }) ?? group[0]!;
    const behavior = behaviors.get(anchor.id)!;
    const site = anchorSite(behavior, (anchor.code ?? '').slice(0, MAX_CODE_CHARS));
    findings.push({
      kind: 'NO_NEGATIVE_PATH',
      severity: group.length >= 3 ? 'MEDIUM' : 'LOW',
      testId: anchor.id,
      testName: anchor.name,
      filePath: anchor.filePath,
      feature: anchor.feature,
      line: site.line,
      quote: site.quote,
      why: `All ${group.length} test(s) covering "${key}" walk the happy path. Nothing here exercises what the feature does with bad input, a rejected request, or a missing resource, so its error handling has never been executed by the suite.`,
      assertInstead: `Add one failing-input case for "${key}": submit invalid or missing data and assert the specific error the user should see (\`await expect(page.getByRole("alert")).toContainText(/…/)\`), plus that the success state did NOT happen (\`await expect(page.getByText("…")).toBeHidden()\`). For an API test, assert the 4xx status AND the error body.`,
    });
  }

  const order: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings.slice(0, MAX_FINDINGS);
}

// ─── Critical-path coverage ──────────────────────────────────────────────────

export interface JourneyCoverage {
  journeyId: string;
  name: string;
  routes: string[];
  /** 0–1: the best single test's share of this journey's routes. */
  bestRatio: number;
  status: 'COVERED' | 'PARTIAL' | 'UNCOVERED';
  coveringTestIds: string[];
  /**
   * True when the only tests touching this journey are quarantined. A
   * quarantined test is a suppressed signal, so this reads as UNCOVERED however
   * good the test is.
   */
  onlyQuarantined: boolean;
}

export interface CriticalPathCoverage {
  available: boolean;
  journeys: JourneyCoverage[];
}

/**
 * Read the serialised FlowMap defensively. The row may have been written by an
 * older Explorer than the types describe, and a shape mismatch must degrade to
 * "no critical-path signal" rather than throw and take the report down.
 */
function criticalJourneys(graph: unknown): Array<{ id: string; name: string; routes: string[] }> {
  if (!graph || typeof graph !== 'object') return [];
  const g = graph as { nodes?: unknown; edges?: unknown; journeys?: unknown };
  if (!Array.isArray(g.nodes) || !Array.isArray(g.journeys)) return [];

  const nodeRoute = new Map<string, string>();
  for (const node of g.nodes) {
    if (!node || typeof node !== 'object') continue;
    const n = node as { id?: unknown; route?: unknown; url?: unknown };
    if (typeof n.id !== 'string') continue;
    if (typeof n.route === 'string' && n.route.startsWith('/')) {
      nodeRoute.set(n.id, normalizeRoute(n.route));
    } else if (typeof n.url === 'string') {
      try {
        nodeRoute.set(n.id, normalizeRoute(new URL(n.url).pathname));
      } catch {
        // A node whose url will not parse simply contributes no route.
      }
    }
  }

  const edgeNodes = new Map<string, [string, string]>();
  if (Array.isArray(g.edges)) {
    for (const edge of g.edges) {
      if (!edge || typeof edge !== 'object') continue;
      const e = edge as { id?: unknown; from?: unknown; to?: unknown };
      if (typeof e.id !== 'string' || typeof e.from !== 'string' || typeof e.to !== 'string') {
        continue;
      }
      edgeNodes.set(e.id, [e.from, e.to]);
    }
  }

  const out: Array<{ id: string; name: string; routes: string[] }> = [];
  for (const journey of g.journeys) {
    if (!journey || typeof journey !== 'object') continue;
    const j = journey as { id?: unknown; name?: unknown; priority?: unknown; edgeIds?: unknown };
    if (j.priority !== 'CRITICAL_PATH') continue;
    if (typeof j.id !== 'string' || !Array.isArray(j.edgeIds)) continue;

    const routes = new Set<string>();
    for (const edgeId of j.edgeIds) {
      if (typeof edgeId !== 'string') continue;
      const ends = edgeNodes.get(edgeId);
      if (!ends) continue;
      for (const nodeId of ends) {
        const route = nodeRoute.get(nodeId);
        if (route) routes.add(route);
      }
    }
    if (routes.size === 0) continue;
    out.push({ id: j.id, name: typeof j.name === 'string' ? j.name : j.id, routes: [...routes] });
  }
  return out;
}

export function coverCriticalPaths(
  behaviors: TestBehavior[],
  tests: Map<string, SuiteHealthTestInput>,
  graph: unknown,
): CriticalPathCoverage {
  const journeys = criticalJourneys(graph);
  if (journeys.length === 0) return { available: false, journeys: [] };

  const testRoutes = behaviors.map((b) => ({
    testId: b.testId,
    routes: new Set(b.routes.map((token) => token.slice('nav:'.length))),
  }));

  const coverage = journeys.map((journey): JourneyCoverage => {
    let bestRatio = 0;
    const covering: string[] = [];

    for (const entry of testRoutes) {
      const hit = journey.routes.filter((route) => entry.routes.has(route)).length;
      if (hit === 0) continue;
      covering.push(entry.testId);
      bestRatio = Math.max(bestRatio, hit / journey.routes.length);
    }

    const live = covering.filter((id) => !tests.get(id)?.quarantined);
    const onlyQuarantined = covering.length > 0 && live.length === 0;

    return {
      journeyId: journey.id,
      name: journey.name,
      routes: journey.routes,
      bestRatio: round(bestRatio, 2),
      status:
        onlyQuarantined || bestRatio === 0 ? 'UNCOVERED' : bestRatio >= 1 ? 'COVERED' : 'PARTIAL',
      coveringTestIds: covering.slice(0, 20),
      onlyQuarantined,
    };
  });

  return { available: true, journeys: coverage };
}

// ─── The score ───────────────────────────────────────────────────────────────

export interface HealthComponent {
  key: string;
  label: string;
  /**
   * False when this component cannot be measured. It is then dropped from the
   * total and the remaining weights are renormalised — a component scored off a
   * partial result would report a suite as healthier than it is.
   */
  available: boolean;
  /** 0–100, or null when unavailable. */
  score: number | null;
  /** Nominal weight, out of 100. */
  weight: number;
  /** Weight after renormalising over the available components. */
  effectiveWeight: number;
  /** score × effectiveWeight / 100 — the points this contributes to the total. */
  contribution: number;
  /** One sentence a human can check the number against. */
  detail: string;
  evidence: Record<string, unknown>;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * Nominal weights. Assertion strength is the largest single term because it is
 * the only one that measures whether the suite would NOTICE a regression;
 * everything else measures how efficiently it would fail to.
 */
export const WEIGHTS = {
  assertionStrength: 30,
  duplication: 20,
  flakiness: 15,
  criticalCoverage: 10,
  negativeCoverage: 10,
  quarantine: 8,
  reliability: 7,
} as const;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export interface ScoreResult {
  score: number;
  grade: Grade;
  components: HealthComponent[];
  /** The arithmetic, written out. A number nobody can decompose is not trusted. */
  formula: string;
}

export function scoreSuiteHealth(args: {
  tests: SuiteHealthTestInput[];
  behaviors: TestBehavior[];
  duplicates: DuplicateScan;
  weakAssertions: WeakAssertion[];
  criticalPaths: CriticalPathCoverage;
}): ScoreResult {
  const { tests, behaviors, duplicates, weakAssertions, criticalPaths } = args;
  const total = tests.length;
  const analyzed = behaviors.filter((b) => !b.incomplete);
  const draft: Array<Omit<HealthComponent, 'effectiveWeight' | 'contribution'>> = [];

  // ── Assertion strength.
  const demeritByTest = new Map<string, number>();
  for (const finding of weakAssertions) {
    if (finding.kind === 'NO_NEGATIVE_PATH') continue; // its own component
    demeritByTest.set(
      finding.testId,
      Math.min(1, (demeritByTest.get(finding.testId) ?? 0) + SEVERITY_DEMERIT[finding.severity]),
    );
  }
  // Scoring off a minority of readable tests would flatter the suite, so it is
  // refused rather than approximated.
  const strengthMeasurable = analyzed.length > 0 && analyzed.length * 2 >= total;
  const avgDemerit =
    analyzed.length === 0
      ? 0
      : analyzed.reduce((sum, b) => sum + (demeritByTest.get(b.testId) ?? 0), 0) / analyzed.length;
  draft.push({
    key: 'assertionStrength',
    label: 'Assertion strength',
    available: strengthMeasurable,
    score: strengthMeasurable ? clamp(Math.round(100 * (1 - avgDemerit))) : null,
    weight: WEIGHTS.assertionStrength,
    detail: strengthMeasurable
      ? `${demeritByTest.size} of ${analyzed.length} fully-read tests carry a weakness (HIGH counts 1.0, MEDIUM 0.5, LOW 0.25, capped at 1 per test). ${total - analyzed.length} test(s) could not be read completely and are excluded.`
      : `Only ${analyzed.length} of ${total} test(s) could be read completely — too few to score. Grading the readable half would flatter the suite.`,
    evidence: {
      testsWithFindings: demeritByTest.size,
      analyzed: analyzed.length,
      total,
      averageDemerit: round(avgDemerit, 3),
      byKind: countBy(
        weakAssertions.filter((f) => f.kind !== 'NO_NEGATIVE_PATH').map((f) => f.kind),
      ),
    },
  });

  // ── Duplication. Deliberately unavailable rather than optimistic when the
  // scan was capped: a shorter duplicate list would RAISE this number.
  const duplicated = new Set<string>();
  for (const cluster of duplicates.clusters) for (const id of cluster.testIds) duplicated.add(id);
  const dupShare = analyzed.length === 0 ? 0 : duplicated.size / analyzed.length;
  const dupMeasurable = duplicates.complete && analyzed.length > 0;
  draft.push({
    key: 'duplication',
    label: 'Duplication',
    available: dupMeasurable,
    // 0% duplicated → 100. 30% or more duplicated → 0. Linear between.
    score: dupMeasurable ? clamp(Math.round(100 * (1 - dupShare / 0.3))) : null,
    weight: WEIGHTS.duplication,
    detail: dupMeasurable
      ? `${duplicated.size} of ${analyzed.length} comparable tests sit in a near-duplicate cluster (${duplicates.clusters.length} cluster(s)). 0% scores 100, 30% or more scores 0.`
      : `Not scored: ${duplicates.incompleteReason ?? 'no test could be compared'}. A partial duplicate list would make this suite look cleaner than it is.`,
    evidence: {
      clusters: duplicates.clusters.length,
      duplicatedTests: duplicated.size,
      comparableTests: analyzed.length,
      pairsReported: duplicates.pairs.length,
      omittedPairs: duplicates.omittedPairs,
      scanComplete: duplicates.complete,
    },
  });

  // ── Flakiness. `flakeRate` is already a percent.
  const avgFlake = total === 0 ? 0 : tests.reduce((sum, t) => sum + (t.flakeRate || 0), 0) / total;
  const flaky = tests.filter((t) => t.flakeRate >= 5);
  draft.push({
    key: 'flakiness',
    label: 'Flakiness',
    available: total > 0,
    // 0% average flake → 100. 20% average → 0.
    score: total > 0 ? clamp(Math.round(100 * (1 - avgFlake / 20))) : null,
    weight: WEIGHTS.flakiness,
    detail: `Average flake rate across ${total} test(s) is ${round(avgFlake, 1)}%; ${flaky.length} test(s) sit at or above 5%. 0% scores 100, 20% scores 0.`,
    evidence: {
      averageFlakeRatePercent: round(avgFlake, 1),
      testsAtOrAbove5Percent: flaky.length,
      worst: [...tests]
        .sort((a, b) => b.flakeRate - a.flakeRate)
        .filter((t) => t.flakeRate > 0)
        .slice(0, 5)
        .map((t) => ({ testId: t.id, name: t.name, flakeRatePercent: round(t.flakeRate, 1) })),
    },
  });

  // ── Critical-path coverage.
  const journeys = criticalPaths.journeys;
  const covered = journeys.filter((j) => j.status === 'COVERED').length;
  const partial = journeys.filter((j) => j.status === 'PARTIAL').length;
  draft.push({
    key: 'criticalCoverage',
    label: 'Critical-path coverage',
    available: criticalPaths.available && journeys.length > 0,
    score:
      criticalPaths.available && journeys.length > 0
        ? clamp(Math.round((100 * (covered + 0.5 * partial)) / journeys.length))
        : null,
    weight: WEIGHTS.criticalCoverage,
    detail:
      criticalPaths.available && journeys.length > 0
        ? `${covered} of ${journeys.length} critical journeys are fully covered, ${partial} partially. A journey whose only tests are quarantined counts as uncovered.`
        : 'Not scored: the project has no flow map with CRITICAL_PATH journeys, so there is nothing to measure coverage against. Run the Explorer to enable this.',
    evidence: {
      journeys: journeys.length,
      covered,
      partial,
      uncovered: journeys
        .filter((j) => j.status === 'UNCOVERED')
        .slice(0, 10)
        .map((j) => j.name),
      onlyQuarantined: journeys.filter((j) => j.onlyQuarantined).map((j) => j.name),
    },
  });

  // ── Error-path coverage.
  const negativeFindings = weakAssertions.filter((f) => f.kind === 'NO_NEGATIVE_PATH');
  const eligibleGroups = new Set(
    tests
      .filter((t) => {
        if (NO_NEGATIVE_PATH_TYPES.has(t.type)) return false;
        const behavior = behaviors.find((b) => b.testId === t.id);
        return Boolean(behavior) && !behavior!.incomplete;
      })
      .map(groupKeyFor),
  );
  const groupCount = eligibleGroups.size;
  draft.push({
    key: 'negativeCoverage',
    label: 'Error-path coverage',
    available: groupCount > 0,
    score:
      groupCount > 0
        ? clamp(Math.round((100 * (groupCount - negativeFindings.length)) / groupCount))
        : null,
    weight: WEIGHTS.negativeCoverage,
    detail:
      groupCount > 0
        ? `${groupCount - negativeFindings.length} of ${groupCount} feature group(s) exercise at least one error path.`
        : 'Not scored: no feature group could be read completely enough to check for an error path.',
    evidence: {
      featureGroups: groupCount,
      groupsWithoutNegativePath: negativeFindings.length,
      examples: negativeFindings.slice(0, 5).map((f) => f.feature ?? f.filePath),
    },
  });

  // ── Quarantine. A quarantined test is a signal deliberately switched off; it
  // is not a neutral state and has to cost the suite something.
  const quarantined = tests.filter((t) => t.quarantined);
  const quarantineShare = total === 0 ? 0 : quarantined.length / total;
  draft.push({
    key: 'quarantine',
    label: 'Quarantined tests',
    available: total > 0,
    // 0% quarantined → 100. 10% or more → 0.
    score: total > 0 ? clamp(Math.round(100 * (1 - quarantineShare / 0.1))) : null,
    weight: WEIGHTS.quarantine,
    detail: `${quarantined.length} of ${total} test(s) are quarantined and no longer gate anything. 0% scores 100, 10% or more scores 0.`,
    evidence: {
      quarantined: quarantined.length,
      criticalPathQuarantined: quarantined.filter((t) => t.priority === 'CRITICAL_PATH').length,
      names: quarantined.slice(0, 10).map((t) => ({ testId: t.id, name: t.name })),
    },
  });

  // ── Persistent failures.
  const rotting = tests.filter((t) => t.consecutiveFailures >= 3);
  const rotShare = total === 0 ? 0 : rotting.length / total;
  draft.push({
    key: 'reliability',
    label: 'Persistent failures',
    available: total > 0,
    score: total > 0 ? clamp(Math.round(100 * (1 - rotShare / 0.1))) : null,
    weight: WEIGHTS.reliability,
    detail: `${rotting.length} of ${total} test(s) have failed 3+ runs in a row. Either the bug is real and unfixed or the test is stale — both mean this part of the suite is not being acted on.`,
    evidence: {
      persistentFailures: rotting.length,
      worst: [...rotting]
        .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures)
        .slice(0, 5)
        .map((t) => ({ testId: t.id, name: t.name, consecutiveFailures: t.consecutiveFailures })),
    },
  });

  const availableWeight = draft.filter((c) => c.available).reduce((sum, c) => sum + c.weight, 0);

  const components: HealthComponent[] = draft.map((c) => {
    const effectiveWeight =
      c.available && availableWeight > 0 ? round((100 * c.weight) / availableWeight, 2) : 0;
    return {
      ...c,
      effectiveWeight,
      contribution: c.score === null ? 0 : round((c.score * effectiveWeight) / 100, 2),
    };
  });

  const score =
    availableWeight === 0 ? 0 : Math.round(components.reduce((sum, c) => sum + c.contribution, 0));

  const formula =
    availableWeight === 0
      ? 'No component could be measured; the score is 0 by default, not by evidence.'
      : `${components
          .filter((c) => c.available)
          .map((c) => `${c.effectiveWeight}% × ${c.score} = ${c.contribution}`)
          .join('  +  ')}  =  ${score}`;

  return { score, grade: gradeFor(score), components, formula };
}

// ─── The report ──────────────────────────────────────────────────────────────

export interface SuiteHealthReport {
  score: number;
  grade: Grade;
  components: HealthComponent[];
  formula: string;
  duplicates: DuplicatePair[];
  duplicateClusters: DuplicateCluster[];
  weakAssertions: WeakAssertion[];
  criticalPaths: JourneyCoverage[];
  totals: {
    tests: number;
    analyzed: number;
    unanalyzed: number;
    duplicatePairs: number;
    duplicateClusters: number;
    weakAssertions: number;
    weakAssertionsBySeverity: Record<Severity, number>;
  };
  /** Tests we could not read end to end. Listed, never silently scored as fine. */
  unanalyzed: Array<{ testId: string; name: string; filePath: string; reason: string }>;
  limits: {
    duplicateScanComplete: boolean;
    duplicateScanNote: string | null;
    pairsCompared: number;
    omittedPairs: number;
    /** Clusters found beyond the payload cap. They ARE in the score. */
    omittedClusters: number;
    skippedCommonTokens: string[];
    minSimilarity: number;
    findingsCapped: boolean;
  };
}

export function analyzeSuiteHealth(input: SuiteHealthInput): SuiteHealthReport {
  const options = input.options ?? {};
  const behaviors: TestBehavior[] = [];
  const byId = new Map<string, TestBehavior>();
  const unanalyzed: SuiteHealthReport['unanalyzed'] = [];

  for (const test of input.tests) {
    let behavior: TestBehavior;
    try {
      behavior = extractBehavior(test);
    } catch (error) {
      /*
       * One malformed row must not take the report down — the reporting rule
       * this codebase keeps relearning. The test is listed as unanalyzed, which
       * is visible, rather than dropped, which is not.
       */
      behavior = {
        testId: test.id,
        name: test.name,
        filePath: test.filePath,
        feature: test.feature,
        priority: test.priority,
        type: test.type,
        routes: [],
        actions: [],
        assertions: [],
        data: [],
        navigationSites: [],
        actionSites: [],
        assertionSites: [],
        incomplete: true,
        incompleteReason: `analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    behaviors.push(behavior);
    byId.set(behavior.testId, behavior);
    if (behavior.incomplete) {
      unanalyzed.push({
        testId: behavior.testId,
        name: behavior.name,
        filePath: behavior.filePath,
        reason: behavior.incompleteReason ?? 'unknown',
      });
    }
  }

  const duplicates = findDuplicates(behaviors, options);
  const weakAssertions = findWeakAssertions(input.tests, byId);
  const criticalPaths = coverCriticalPaths(
    behaviors,
    new Map(input.tests.map((t) => [t.id, t])),
    input.flowMapGraph,
  );

  const scored = scoreSuiteHealth({
    tests: input.tests,
    behaviors,
    duplicates,
    weakAssertions,
    criticalPaths,
  });

  const bySeverity: Record<Severity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const finding of weakAssertions) bySeverity[finding.severity] += 1;

  return {
    score: scored.score,
    grade: scored.grade,
    components: scored.components,
    formula: scored.formula,
    duplicates: duplicates.pairs,
    // Sliced for payload only — `scoreSuiteHealth` above already saw them all.
    duplicateClusters: duplicates.clusters.slice(0, MAX_REPORTED_CLUSTERS),
    weakAssertions,
    criticalPaths: criticalPaths.journeys,
    totals: {
      tests: input.tests.length,
      analyzed: behaviors.length - unanalyzed.length,
      unanalyzed: unanalyzed.length,
      duplicatePairs: duplicates.pairs.length,
      /** The true count, even when the list above was sliced for payload. */
      duplicateClusters: duplicates.clusters.length,
      weakAssertions: weakAssertions.length,
      weakAssertionsBySeverity: bySeverity,
    },
    unanalyzed,
    limits: {
      duplicateScanComplete: duplicates.complete,
      duplicateScanNote: duplicates.incompleteReason,
      pairsCompared: duplicates.pairsCompared,
      omittedPairs: duplicates.omittedPairs,
      omittedClusters: Math.max(0, duplicates.clusters.length - MAX_REPORTED_CLUSTERS),
      skippedCommonTokens: duplicates.skippedCommonTokens,
      minSimilarity: options.minSimilarity ?? DEFAULT_MIN_SIMILARITY,
      findingsCapped: weakAssertions.length >= MAX_FINDINGS,
    },
  };
}

// ─── Optional model polish ───────────────────────────────────────────────────

export const SUITE_HEALTH_SYSTEM = `You are writing the summary paragraph for a QA suite-health report.

The report was produced by static analysis. Every number, duplicate pair and
finding in it is already established — you are NOT re-deciding any of them, and
you must not introduce a finding the report does not contain.

Write for the engineer who owns the suite. Lead with the single thing costing
them the most, name the tests involved, and say what it would take to fix. Do
not recommend deleting a test: a duplicate that differs in one assertion is
frequently the only test that catches a regression, and deletion is
unrecoverable. Recommend that a human compare them.

Six sentences at most. No preamble, and do not restate the score they can
already see.`;

/**
 * Prompt material for an optional narrative summary.
 *
 * Nothing in this module calls a model. This exists so the explanation can be
 * upgraded later without any of the analysis above moving — and so that when the
 * model is unavailable the report is unaffected, because the report was never
 * waiting on it.
 */
export function suiteHealthPrompt(report: SuiteHealthReport): { system: string; user: string } {
  const lines: string[] = [
    `Score: ${report.score}/100 (${report.grade})`,
    '',
    'Components:',
    ...report.components.map(
      (c) =>
        `  ${c.label}: ${
          c.available ? `${c.score}/100 at ${c.effectiveWeight}% weight` : 'not measured'
        } — ${c.detail}`,
    ),
    '',
    `Duplicate clusters (${report.duplicateClusters.length}):`,
    ...report.duplicateClusters
      .slice(0, 10)
      .map(
        (c) => `  ${c.size} tests: ${c.members.map((m) => m.name).join(' | ')} — ${c.recommendation}`,
      ),
    '',
    `Weak assertions (${report.weakAssertions.length}, showing up to 20):`,
    ...report.weakAssertions
      .slice(0, 20)
      .map(
        (f) => `  [${f.severity}] ${f.kind} in "${f.testName}" line ${f.line ?? '?'}: ${f.quote}`,
      ),
  ];

  if (report.unanalyzed.length > 0) {
    lines.push(
      '',
      `Not analysed (${report.unanalyzed.length}): these were not read completely, so no absence-based finding was made about them.`,
    );
  }
  if (!report.limits.duplicateScanComplete) {
    lines.push(
      '',
      `Duplicate scan incomplete: ${report.limits.duplicateScanNote}. The duplicate list is a floor, not a total.`,
    );
  }

  return { system: SUITE_HEALTH_SYSTEM, user: lines.join('\n') };
}
