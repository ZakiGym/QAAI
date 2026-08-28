/**
 * "Why did it fail" — one sentence, computed, never generated.
 *
 * A failed result today hands the reader a stack, a message and a trace and
 * lets them do the translation. That translation is not model work: the
 * runner's plugins each write their failures in their own fixed vocabulary,
 * and the vocabulary is what names the KIND. A Playwright locator that matched
 * nothing, an axe violation and a k6 threshold breach are three different
 * bugs with three different first moves, and telling them apart is pattern
 * work on text this repo already controls.
 *
 * So this module is deliberately deterministic. It runs on a deployment with
 * no model key at all, because the part that saves time — naming the kind —
 * never needed one.
 *
 * Two rules hold it honest, and both exist because the alternative is worse
 * than saying nothing:
 *
 *  - ORDER IS THE CLASSIFIER. `page.goto: net::ERR_CONNECTION_REFUSED` is a
 *    navigation failure AND a network failure, and only one of those tells
 *    the reader what to do first ("is the app even up"). Every ordering
 *    decision below is a claim about which first move is right, and each one
 *    carries its reason.
 *  - AN UNRECOGNISED FAILURE STAYS UNRECOGNISED. `classified` goes false, the
 *    next action goes silent, and the headline is the raw error verbatim. A
 *    confident wrong sentence at the top of a red run is more expensive than
 *    no sentence, because it is read first and believed.
 */

import type { TestResultStatus } from './constants';

// ─── The kinds ───────────────────────────────────────────────────────────────

/**
 * Each kind exists because its FIRST MOVE differs from every other kind's.
 * "The selector matched nothing" and "the selector matched three things" are
 * one kind by cause and two by remedy, so they are two kinds here.
 */
export const FAILURE_KINDS = [
  'ENVIRONMENT',
  'FIXTURE',
  'CRASH',
  'NETWORK',
  'NAVIGATION',
  'SELECTOR_AMBIGUOUS',
  'ELEMENT_STATE',
  'SELECTOR_NOT_FOUND',
  'PAGE_ERROR',
  'VISUAL_DIFF',
  'ACCESSIBILITY',
  'SECURITY',
  'CONTRACT',
  'BUDGET',
  'ASSERTION',
  'TIMEOUT',
  'UNKNOWN',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The chip. Short enough to read before the sentence under it. */
export const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  ENVIRONMENT: 'Environment gap',
  FIXTURE: 'Test data problem',
  CRASH: 'The runner reported nothing',
  NETWORK: 'Network failure',
  NAVIGATION: 'Navigation never settled',
  SELECTOR_AMBIGUOUS: 'Selector matched more than one',
  ELEMENT_STATE: 'Element was not actionable',
  SELECTOR_NOT_FOUND: 'Selector matched nothing',
  PAGE_ERROR: 'Uncaught JavaScript error',
  VISUAL_DIFF: 'Visual difference',
  ACCESSIBILITY: 'Accessibility violation',
  SECURITY: 'Security finding',
  CONTRACT: 'Contract mismatch',
  BUDGET: 'Budget exceeded',
  ASSERTION: 'Assertion mismatch',
  TIMEOUT: 'Timeout',
  UNKNOWN: 'Unclassified',
};

/**
 * The next move, and only where the kind actually implies one.
 *
 * Five kinds are deliberately silent. An assertion mismatch already says
 * everything in its own headline — "expected 3, got 2" needs no coaching. A
 * budget breach prints both numbers. A generic line under every failure is
 * how a box gets skipped, and once it is skipped the useful lines go with it.
 */
const NEXT_ACTIONS: Record<FailureKind, string | null> = {
  ENVIRONMENT:
    'Nothing about the application was tested here — a piece the runner needs is missing from the worker. ' +
    'Install it and re-run; do not read this as a failing app.',
  FIXTURE:
    'The test could not be turned into cases, so no case ran. Fix the spec or the dataset it reads, ' +
    'then re-run — this result says nothing about the application yet.',
  CRASH:
    'The runner exited without a usable report, so no assertion was evaluated. The output below comes ' +
    'from the process itself, not from a test.',
  NETWORK:
    'The transport failed before any assertion ran. Check that the service is up and that the ' +
    "environment's base URL points at it.",
  NAVIGATION:
    'The page never reached a settled state. Load the URL yourself and watch what stays pending.',
  SELECTOR_AMBIGUOUS:
    'The page now has more than one match, so the locator is no longer specific. Narrow it — a role ' +
    'plus an accessible name survives markup churn better than a nth-match.',
  ELEMENT_STATE:
    'The element was found but could not be used — covered, hidden, disabled or still moving. The ' +
    'failure screenshot is the fastest read here.',
  SELECTOR_NOT_FOUND:
    'Confirm the element still exists under that name. If the markup moved, this is a heal candidate; ' +
    'if the element is genuinely gone, that is the bug.',
  PAGE_ERROR:
    'An exception was thrown in the page, not in the test. Read the console entries around this step ' +
    'before touching the spec.',
  VISUAL_DIFF:
    'Look at the diff image. If the change was intended, approve the new baseline — there is no code ' +
    'fix to make.',
  ACCESSIBILITY:
    'Each violation names an axe rule and links its documentation. The rule is the thing to fix.',
  SECURITY: null,
  CONTRACT:
    'The response no longer matches the document it is checked against. Provider and document are owned ' +
    'by different people, so decide which one drifted before changing either.',
  BUDGET: null,
  ASSERTION: null,
  TIMEOUT:
    'Nothing named what the step was waiting for. Open the trace and watch the step that was in flight ' +
    'when the clock ran out.',
  UNKNOWN: null,
};

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * One step, in the shape both the API row and the runner's StepResult already
 * have. `errorStack` is optional because not every caller carries it — the
 * comparison screen has an error message and nothing else.
 */
export interface FailureSummaryStep {
  index: number;
  title: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  errorMessage: string | null;
  errorStack?: string | null;
  selector: string | null;
  expected: string | null;
  actual: string | null;
}

/**
 * `testType` is a plain string rather than the `TestType` union on purpose:
 * the API returns it untyped and the web's `TestResult` declares it as
 * `string`, so demanding the union here would buy one cast at every call site
 * and no safety at all — an unrecognised type simply matches no rule.
 */
export interface FailureSummaryInput {
  status: TestResultStatus;
  testType?: string | null;
  errorMessage: string | null;
  retriedAndPassed?: boolean;
  steps?: readonly FailureSummaryStep[];
  filePath?: string | null;
  findings?: readonly { kind: string; severity: string }[];
  /**
   * How this same test ended on the PREVIOUS run that executed it. Supplied by
   * the caller from the test's own history, because "it failed here and passed
   * last time" and "it has been failing for a week" are different bugs and the
   * result row alone cannot tell them apart.
   */
  previousOutcome?: TestResultStatus | null;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface FailureLocation {
  /** The failing step, when the runner recorded steps at all. */
  step: { index: number; title: string } | null;
  /** The spec file — taken from the stack when it names one, else the test's own path. */
  file: string | null;
  line: number | null;
  selector: string | null;
}

/**
 * `looksFlaky` is true only for the retry case, which is the one place
 * flakiness is OBSERVED rather than inferred. A test that passed on the
 * previous run might be flaky or might be a fresh regression, and this module
 * refuses to guess which.
 */
export interface ReliabilityNote {
  signal: 'RETRIED_AND_PASSED' | 'NEW_SINCE_LAST_RUN' | 'FAILING_BEFORE' | 'FLAKY_BEFORE';
  looksFlaky: boolean;
  sentence: string;
}

export interface FailureSummary {
  kind: FailureKind;
  kindLabel: string;
  /** What broke, in the words of the assertion. Never a stack. */
  headline: string;
  location: FailureLocation;
  /** Null wherever the kind does not imply a confident first move. */
  nextAction: string | null;
  notes: ReliabilityNote[];
  /**
   * False when no rule matched. The caller must then present `headline` as the
   * raw error it is, and must not present the kind as a finding.
   */
  classified: boolean;
  /** Exactly the text that was classified, so the UI can always show the original. */
  raw: string | null;
}

// ─── Text helpers ────────────────────────────────────────────────────────────

/** A headline is a sentence, not a paragraph. Past this it stops being read. */
const HEADLINE_LIMIT = 200;

/**
 * Lines that carry no information on their own: Playwright's call-log header,
 * its indented waiting-for entries, and stack frames. Dropping them is what
 * makes the first surviving line the sentence a person would have written.
 */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^Call log:?$/i.test(trimmed)) return true;
  if (/^-\s/.test(trimmed)) return true;
  if (/^at\s/.test(trimmed)) return true;
  return false;
}

function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (isNoiseLine(line)) continue;
    const cleaned = line.trim().replace(/^Error:\s*/, '').replace(/\s+/g, ' ');
    if (cleaned) return truncate(cleaned);
  }
  return null;
}

function truncate(text: string): string {
  return text.length <= HEADLINE_LIMIT ? text : `${text.slice(0, HEADLINE_LIMIT - 1).trimEnd()}…`;
}

function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

/**
 * The locator, from the text, when the caller did not already have it parsed.
 * Prefers the call log's `waiting for locator(...)` over the first locator
 * mentioned anywhere: on a chained failure the call log names the one that
 * actually stalled.
 */
function extractSelector(text: string): string | null {
  const waiting = /waiting for ((?:locator|get[Bb]y\w+|frameLocator)\([^\n]*?\))/.exec(text);
  if (waiting?.[1]) return waiting[1];
  const anywhere = /(?:locator|get[Bb]y\w+)\((.*?)\)/.exec(text);
  return anywhere?.[0] ?? null;
}

/**
 * The spec file and line, from a stack.
 *
 * Frames inside `node_modules` are skipped: the top frame of a Playwright
 * failure is almost always inside the library, and pointing a reader at
 * `expect.js:412` is worse than pointing them nowhere. When the caller told us
 * the test's own path, a frame in that file wins outright.
 */
function locateInStack(stack: string | null | undefined, filePath: string | null | undefined): {
  file: string | null;
  line: number | null;
} {
  if (!stack) return { file: null, line: null };

  const wanted = filePath ? basename(filePath) : null;
  let fallback: { file: string; line: number } | null = null;

  for (const match of stack.matchAll(/([^\s()]+\.[A-Za-z]{1,4}):(\d+)(?::\d+)?/g)) {
    const file = match[1];
    const rawLine = match[2];
    if (!file || !rawLine) continue;
    const line = Number(rawLine);
    if (!Number.isFinite(line)) continue;
    if (wanted && basename(file) === wanted) return { file, line };
    if (!fallback && !file.includes('node_modules')) fallback = { file, line };
  }

  return fallback ?? { file: null, line: null };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

// ─── Classification ──────────────────────────────────────────────────────────

interface Signals {
  text: string;
  status: TestResultStatus;
  testType: string;
  step: FailureSummaryStep | null;
  findingKinds: ReadonlySet<string>;
}

/** True when the text matches any of the patterns. */
function any(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * A missing browser engine, an absent k6, a suite that could not be imported.
 * Every one of these means NOTHING was evaluated, and the plugins already say
 * so in a fixed set of phrases — see the ENOENT branches in load.ts,
 * external.ts, mobile.ts and playwright-harness.ts.
 *
 * First, unconditionally. These messages routinely also contain the word
 * "timeout" or a stack, and classifying one of them as a failing test is the
 * exact mistake the runner has already been patched for three times: it blames
 * the customer's application for our worker image.
 */
const ENVIRONMENT_PATTERNS: readonly RegExp[] = [
  /is not installed on this worker/,
  /not executable on this worker/,
  /Executable doesn't exist at/,
  /npx playwright install/,
  /could not be loaded, so no test was evaluated/,
  /dependency missing from the worker/,
  /is not in a format QAAI recognises/,
  /No report found at /,
  /wrote no report at /,
  /reported no test cases, so nothing was evaluated/,
  /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/,
  /NoClassDefFoundError|ClassNotFoundException|cannot load such file/,
];

/**
 * The test's own inputs are broken: an invalid spec, a dataset that produced
 * no rows, a placeholder nothing fills. Distinct from ENVIRONMENT because the
 * fix is in the test, and distinct from ASSERTION because no case ran at all.
 */
const FIXTURE_PATTERNS: readonly RegExp[] = [
  /has an invalid spec —/,
  /no case was executed/,
  /it needs a header row and at least one row/,
  /which no dataset column, variable, secret or earlier extraction provides/,
  /Refusing to write fixture outside the workspace/,
];

/** The process produced no report, or died before writing one. */
const CRASH_PATTERNS: readonly RegExp[] = [
  /produced no report/,
  /produced no summary/,
  /did not finish within \d+s/,
  /^Could not run `/m,
];

/**
 * Transport, before navigation. `page.goto: net::ERR_CONNECTION_REFUSED` is
 * both, and only one of the two readings leads anywhere: nothing is listening,
 * so the URL and the service are what to check, not the page's load state.
 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /\b(?:ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|EPIPE)\b/,
  /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|EMPTY_RESPONSE|SSL_PROTOCOL_ERROR|CERT_[A-Z_]+)/,
  /Request failed: /,
  /The provider could not be reached: /,
  /Could not connect to /,
  /fetch failed|socket hang up/,
  /self[- ]signed certificate|unable to verify the first certificate/,
];

/** Navigation that never settled — reached only once transport is ruled out. */
const NAVIGATION_PATTERNS: readonly RegExp[] = [
  /page\.goto|page\.reload|waitForURL|waitForNavigation|waitForLoadState/,
  /networkidle/,
  /Navigation to .* is interrupted|net::ERR_ABORTED/,
];

const SELECTOR_AMBIGUOUS_PATTERNS: readonly RegExp[] = [
  /strict mode violation/i,
  /resolved to [2-9]\d* elements|resolved to \d{2,} elements/,
];

/**
 * The element WAS found and could not be used. Checked before "matched
 * nothing", because Playwright prints the same call log for both and only
 * these phrases distinguish "it is not there" from "it is there and covered" —
 * two different screens to go look at.
 */
const ELEMENT_STATE_PATTERNS: readonly RegExp[] = [
  /element is not visible|element is not enabled|element is not stable|element is not editable/,
  /not attached to the DOM|element is detached/,
  /intercepts pointer events/,
  /outside of the viewport/,
];

const SELECTOR_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /waiting for (?:locator|get[Bb]y\w+|frameLocator)\(/,
  /resolved to 0 elements/,
  /Unable to locate element|NoSuchElementError|no element matches/i,
];

const PAGE_ERROR_PATTERNS: readonly RegExp[] = [
  /Uncaught \(in promise\)|Uncaught [A-Z]\w*Error|pageerror/,
  /\b(?:TypeError|ReferenceError|RangeError|SyntaxError): /,
  /Cannot read propert(?:y|ies) of (?:undefined|null)/,
];

const VISUAL_PATTERNS: readonly RegExp[] = [
  /pixels changed \(/,
  /The rendered size changed:/,
  /over the [\d.]+% this test allows/,
];

const ACCESSIBILITY_PATTERNS: readonly RegExp[] = [
  /critical accessibility violation/,
  /One or more routes could not be scanned/,
];

const SECURITY_PATTERNS: readonly RegExp[] = [/security finding\(s\)/];

const CONTRACT_PATTERNS: readonly RegExp[] = [
  /is missing the required property/,
  /has the undocumented property/,
  /the document declares/,
  /matches none of the \d+ .* alternatives/,
];

/** A number against a number the run owner chose: k6 thresholds, web-vitals budgets, latency caps. */
const BUDGET_PATTERNS: readonly RegExp[] = [
  /budget is \d+ms/,
  /over the .{0,40}budget/,
  /exceeded its budget/,
  /over the \d[\d.]*ms threshold/,
  /over the [\d.]+% threshold/,
  /k6 sent no requests/,
];

/**
 * Only phrases that carry actual VALUES. A bare `expect(locator).toBeVisible()`
 * with a timeout under it is a selector problem wearing an assertion's clothes,
 * and matching on `expect(` would file it here and send the reader to the wrong
 * screen.
 */
const ASSERTION_PATTERNS: readonly RegExp[] = [
  /Expected [^\n]{0,120}, got /,
  /Expected (?:string|value|pattern|object|array|substring|count|number):/i,
  /Received (?:string|value|object|array):/i,
  /AssertionError/,
  /Body at "[^"\n]{0,200}" was /,
  /Response body does not contain /,
  /Response was not valid JSON/,
  /Response carried neither "data" nor "errors"/,
  /Expected the operation to return errors/,
  /[^\n]{0,120} was [^\n]{0,120}, expected /,
  /Expected at (?:least|most) \d+ row/,
];

const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /Timeout \d+ms exceeded/,
  /Test timeout of \d+ms exceeded/,
  /exceeded \d+s and was stopped/,
  /\btimed out\b/i,
];

/**
 * The kind, and nothing else. Exported because it is the part worth testing
 * exhaustively against real captured text, and because the comparison screen
 * wants the label without the rest of the summary.
 *
 * Returns null — not UNKNOWN — when no rule fires, so the caller cannot mistake
 * "we looked and found nothing" for a classification.
 */
export function classifyFailureKind(input: FailureSummaryInput): FailureKind | null {
  const signals = signalsFor(input);
  return signals.text ? ruleMatch(signals) : null;
}

function ruleMatch(s: Signals): FailureKind | null {
  const { text } = s;

  if (any(text, ENVIRONMENT_PATTERNS)) return 'ENVIRONMENT';
  if (any(text, FIXTURE_PATTERNS)) return 'FIXTURE';
  if (any(text, CRASH_PATTERNS)) return 'CRASH';
  if (any(text, NETWORK_PATTERNS)) return 'NETWORK';
  if (any(text, NAVIGATION_PATTERNS)) return 'NAVIGATION';
  if (any(text, SELECTOR_AMBIGUOUS_PATTERNS)) return 'SELECTOR_AMBIGUOUS';
  if (any(text, ELEMENT_STATE_PATTERNS)) return 'ELEMENT_STATE';
  if (any(text, SELECTOR_NOT_FOUND_PATTERNS)) return 'SELECTOR_NOT_FOUND';
  if (any(text, PAGE_ERROR_PATTERNS)) return 'PAGE_ERROR';

  // The type-led kinds. A visual test's failure is a visual difference whatever
  // words it used, and the plugins for these four types produce a small, fixed
  // set of messages — so the type is a stronger signal here than any phrase.
  if (s.testType === 'VISUAL' || s.findingKinds.has('VISUAL') || any(text, VISUAL_PATTERNS)) {
    return 'VISUAL_DIFF';
  }
  if (
    s.testType === 'ACCESSIBILITY' ||
    s.findingKinds.has('ACCESSIBILITY') ||
    any(text, ACCESSIBILITY_PATTERNS)
  ) {
    return 'ACCESSIBILITY';
  }
  if (s.testType === 'SECURITY_SMOKE' || s.findingKinds.has('SECURITY') || any(text, SECURITY_PATTERNS)) {
    return 'SECURITY';
  }
  if (s.testType === 'CONTRACT' || any(text, CONTRACT_PATTERNS)) return 'CONTRACT';

  if (any(text, BUDGET_PATTERNS)) return 'BUDGET';

  // An assertion with both sides recorded beats a timeout: "expected 3, got 2"
  // is the whole story, and the 30s the runner spent retrying it is not.
  if ((s.step?.expected && s.step.actual) || any(text, ASSERTION_PATTERNS)) return 'ASSERTION';

  if (s.status === 'TIMED_OUT' || any(text, TIMEOUT_PATTERNS)) return 'TIMEOUT';

  return null;
}

// ─── Assembly ────────────────────────────────────────────────────────────────

/** The step the failure belongs to, or null when the runner recorded no steps. */
function failingStep(input: FailureSummaryInput): FailureSummaryStep | null {
  return (input.steps ?? []).find((s) => s.status === 'FAILED') ?? null;
}

/**
 * Everything a rule is allowed to look at, assembled once.
 *
 * The text is the step's error first and the test-level message second: the
 * step's message is the specific one, while the test-level message is a
 * summary that may carry an appended determinism hint. Classifying the
 * specific text keeps that seed footer out of the decision.
 */
function signalsFor(input: FailureSummaryInput): Signals {
  const step = failingStep(input);
  return {
    text: step?.errorMessage?.trim() || input.errorMessage?.trim() || '',
    status: input.status,
    testType: (input.testType ?? '').toUpperCase(),
    step,
    findingKinds: new Set((input.findings ?? []).map((f) => f.kind.toUpperCase())),
  };
}

function buildHeadline(kind: FailureKind | null, s: Signals): string | null {
  const { text, step } = s;
  const selector = step?.selector ?? extractSelector(text);

  if (kind === 'ASSERTION' && step?.expected && step.actual) {
    return truncate(`Expected ${step.expected}, got ${step.actual}`);
  }

  if (kind === 'SELECTOR_NOT_FOUND' && selector) {
    return truncate(`Nothing on the page matched ${selector}`);
  }

  if (kind === 'SELECTOR_AMBIGUOUS') {
    const count = /resolved to (\d+) elements/.exec(text)?.[1];
    if (count && selector) {
      return truncate(`${selector} matched ${count} elements, and the step needs exactly one`);
    }
  }

  if (kind === 'TIMEOUT') {
    const ms = /Timeout (\d+)ms exceeded|Test timeout of (\d+)ms exceeded/.exec(text);
    const raw = ms?.[1] ?? ms?.[2];
    if (raw) {
      const waited = humanMs(Number(raw));
      return truncate(step ? `Timed out after ${waited} in "${step.title}"` : `Timed out after ${waited}`);
    }
  }

  return firstMeaningfulLine(text);
}

/**
 * The reliability read. Two independent signals, so both can be true: a test
 * can have passed on a retry inside this run AND have been failing yesterday,
 * and each is worth saying on its own.
 */
function reliabilityNotes(input: FailureSummaryInput): ReliabilityNote[] {
  const notes: ReliabilityNote[] = [];

  if (input.retriedAndPassed || input.status === 'FLAKY') {
    notes.push({
      signal: 'RETRIED_AND_PASSED',
      looksFlaky: true,
      sentence:
        'It failed and then passed on a retry inside this run. That is the definition of a flake ' +
        'candidate — the gate treats it as one, and a retry that passes is not a pass.',
    });
  }

  switch (input.previousOutcome) {
    case 'PASSED':
      notes.push({
        signal: 'NEW_SINCE_LAST_RUN',
        // A pass last time is consistent with a flake AND with a fresh
        // regression, and picking one of those for the reader would be a guess
        // dressed as a finding.
        looksFlaky: false,
        sentence: 'It passed the last time it ran, so this failure is new.',
      });
      break;
    case 'FAILED':
    case 'TIMED_OUT':
      notes.push({
        signal: 'FAILING_BEFORE',
        looksFlaky: false,
        sentence: 'It also failed the last time it ran, so this is not a one-off.',
      });
      break;
    case 'FLAKY':
      notes.push({
        signal: 'FLAKY_BEFORE',
        looksFlaky: true,
        sentence: 'It was already a flake candidate on its previous run.',
      });
      break;
    default:
      break;
  }

  return notes;
}

/**
 * The whole box.
 *
 * Returns null when there is nothing to explain — a clean pass, or a skip the
 * runner said nothing about. A summary that appears over a green result is
 * noise, and noise is what gets the box collapsed and never reopened.
 */
export function summariseFailure(input: FailureSummaryInput): FailureSummary | null {
  const retried = Boolean(input.retriedAndPassed);
  if (input.status === 'PASSED' && !retried) return null;
  if (input.status === 'SKIPPED' && !input.errorMessage?.trim()) return null;

  const signals = signalsFor(input);
  const { step, text } = signals;

  const kind = text ? ruleMatch(signals) : null;
  const notes = reliabilityNotes(input);

  // No early return for an empty message: a result that failed and recorded
  // nothing is exactly the case a reader needs told, and the two guards above
  // have already turned away everything that is not a failure.
  const headline =
    buildHeadline(kind, signals) ??
    (input.status === 'TIMED_OUT'
      ? 'The test timed out and left no message.'
      : retried
        ? 'The test failed on its first attempt and left no message.'
        : 'The test failed and left no error message.');

  const stackLocation = locateInStack(step?.errorStack, input.filePath);

  return {
    kind: kind ?? 'UNKNOWN',
    kindLabel: FAILURE_KIND_LABELS[kind ?? 'UNKNOWN'],
    headline,
    location: {
      step: step ? { index: step.index, title: step.title } : null,
      file: stackLocation.file ?? input.filePath ?? null,
      line: stackLocation.line,
      selector: step?.selector ?? (text ? extractSelector(text) : null),
    },
    nextAction: kind ? nextActionFor(kind, text) : null,
    notes,
    classified: kind !== null,
    raw: text || null,
  };
}

/**
 * `networkidle` earns its own clause because its failure mode is specific and
 * counter-intuitive: a page holding one long-lived socket never fires it, and
 * the test looks hung when nothing is wrong with the page at all.
 */
function nextActionFor(kind: FailureKind, text: string): string | null {
  const base = NEXT_ACTIONS[kind];
  if (!base) return null;
  if (kind === 'NAVIGATION' && /networkidle/.test(text)) {
    return `${base} A page holding an open socket — a websocket, a poll, an analytics beacon — never reaches networkidle at all.`;
  }
  return base;
}
