/**
 * Test-from-bug-report — paste a ticket, get a test that reproduces it.
 *
 * The whole feature turns on one property, and everything in this file is
 * arranged to protect it:
 *
 *   **A reproduction that PASSES has not reproduced anything.**
 *
 * A generated test that goes green against the app the reporter says is broken
 * is not a reproduction — it is a test of something else that happens to work.
 * So the assertions this file builds assert the EXPECTED behaviour (the thing
 * the reporter says does not happen), never the actual one, and `reproVerdict`
 * refuses to call a green run a success no matter how good the code looks.
 *
 * The other half is that bug reports are semi-structured, not unstructured.
 * "Steps to reproduce:", "1.", "Expected:", "Actual:", a fenced stack trace, a
 * pasted URL — these are conventions, and parsing them is free, deterministic
 * and repeatable in a way a model is not. Every one of them is extracted here
 * BEFORE a model is asked for anything, for three reasons:
 *
 *   1. What was extracted can be shown to the user and corrected. A model's
 *      reading of the ticket cannot.
 *   2. Extracted URLs get matched against the Flow Map, so the test starts from
 *      a route that exists rather than one the reporter half-remembered.
 *   3. Extracted selectors, routes and error strings are what the duplicate
 *      check compares. Writing a second test for a bug already covered is the
 *      cheapest way to make a suite worse.
 *
 * The model's job is narrow: turn a plan item this file assembled into code.
 * When the prose is too thin to yield steps, `enrichReport` asks for those —
 * and `mergeEnrichment` records which fields it supplied, so nothing the model
 * invented is ever presented as something the reporter wrote.
 *
 * Nothing here performs HTTP. `parseIssueUrl` reads a pasted tracker URL into a
 * provider + identifier and hands the hostname back as DATA TO COMPARE; the API
 * route holds it against the configured integration and fetches through the
 * client in apps/api/src/lib/issues.ts, which owns the host pinning and the
 * no-redirect rule. A second HTTP client with its own security posture is
 * exactly the bug that file's history is about.
 */

import { z } from 'zod';
import type { FlowMap, Language, PlanItem, Priority, TestResultStatus, UiFramework } from '@qaai/shared';
import { generateTest } from './generator.js';
import type { GeneratedTest } from './generator.js';
import type { CallContext, LlmService } from './llm.js';

// ─── Limits ──────────────────────────────────────────────────────────────────

/** A pasted ticket longer than this is a log dump; parse the head of it. */
export const MAX_REPORT_CHARS = 200_000;

/** planItemSchema caps steps at 40 and assertions at 20. Stay inside both. */
const MAX_STEPS = 40;
const MAX_ASSERTIONS = 20;
const MAX_STEP_CHARS = 300;
/** An expected/actual sentence; longer than a step, short enough for a rationale. */
const MAX_PROSE_CHARS = 400;
const MAX_LIST = 20;
const MAX_TITLE = 160;
const MAX_RATIONALE = 1000;
const MAX_FEATURE = 80;
const MAX_NARRATIVE = 4_000;
const MAX_ERROR_CHARS = 500;
const MAX_FENCE_CHARS = 2_000;

/** Below this the prose gave up too little to generate from; ask the model. */
export const ENRICH_BELOW_SCORE = 0.45;

/** A duplicate must clear this AND agree on at least two independent signals. */
export const DUPLICATE_THRESHOLD = 0.6;

// ─── Tracker URLs ────────────────────────────────────────────────────────────

export type IssueProvider = 'GITHUB' | 'JIRA' | 'LINEAR';

/**
 * A pasted tracker URL, reduced to the parts that may safely choose a PATH.
 *
 * `host` is deliberately NOT a destination. It is returned so the caller can
 * hold it against the host on the configured integration and refuse a mismatch;
 * the request itself is always built from the integration's own (already
 * validated) site or from a pinned API host. This is the same division issues.ts
 * makes — config picks a path, never a host — and the reason it exists is that
 * the value here came from a request body, which is a strictly worse source than
 * config.
 */
export interface IssueRef {
  provider: IssueProvider;
  /** Lowercased, trailing dots stripped. Compare with this; never fetch it. */
  host: string;
  /** GitHub only: `owner/repo`. Empty for the others. */
  repo: string;
  /** GitHub: `123`. Jira: `QA-12`. Linear: `ENG-42`. Safe to put in a path. */
  key: string;
  /** True when a GitHub URL pointed at a pull request rather than an issue. */
  isPullRequest: boolean;
}

export class ReproInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproInputError';
  }
}

/**
 * A fully-qualified name may end in a dot and DNS resolves it identically, so
 * `localhost.` and `localhost` are the same machine. issues.ts learned that the
 * hard way (a trailing dot walked a Jira credential past every guard it had);
 * anything here that will later be COMPARED to a hostname has to be normalised
 * the same way, or the comparison is the bypass.
 */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}-\d{1,10}$/;
const LINEAR_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,10}$/;

const SUPPORTED_SHAPES =
  'https://github.com/owner/repo/issues/123, ' +
  'https://linear.app/team/issue/ENG-42, or ' +
  'https://your-site.atlassian.net/browse/QA-12';

/**
 * Read a pasted issue URL into a provider and an identifier.
 *
 * Everything returned is either a fixed enum or matched against an anchored
 * pattern, so no part of it can smuggle a path segment. A URL this cannot make
 * sense of is refused with the shapes that work rather than being guessed at —
 * a guess here becomes an authenticated request somewhere nobody chose.
 */
export function parseIssueUrl(raw: string): IssueRef {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new ReproInputError('No issue URL was given.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Deliberately does not echo the input: an unparseable value is exactly
    // where a pasted `https://user:token@host/x` ends up.
    throw new ReproInputError(`That issue URL could not be parsed. Try ${SUPPORTED_SHAPES}.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ReproInputError('An issue URL must be http or https.');
  }
  if (url.username || url.password) {
    throw new ReproInputError(
      'Remove the credentials from the issue URL — QAAI uses the token stored on the integration.',
    );
  }

  const host = normaliseHost(url.hostname);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);

  if (GITHUB_HOSTS.has(host)) return githubRef(host, segments);
  if (host === 'linear.app' || host.endsWith('.linear.app')) return linearRef(host, segments);
  return jiraRef(host, segments, url.searchParams.get('selectedIssue'));
}

/**
 * A path segment can be percent-encoded, and `%2e%2e` is `..`. Decoding here
 * means the anchored patterns below see what the server would see, rather than
 * approving an encoded form and letting it decode into something else later.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function githubRef(host: string, segments: string[]): IssueRef {
  // /owner/repo/issues/123 — and /pull/123, because GitHub's issues API serves
  // pull requests too and a reporter linking the PR means the same thing.
  const [owner, repo, kind, number] = segments;
  if (!owner || !repo || (kind !== 'issues' && kind !== 'pull') || !number) {
    throw new ReproInputError(
      'That GitHub URL is not an issue link — it should look like https://github.com/owner/repo/issues/123.',
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new ReproInputError('That GitHub URL does not name a valid owner and repository.');
  }
  // `.` and `..` satisfy the character class above and would resolve away once
  // interpolated into a path. issues.ts rejects them explicitly for the same
  // reason and this must not be the place that forgets.
  if ([owner, repo].some((part) => part === '.' || part === '..')) {
    throw new ReproInputError('That GitHub URL does not name a valid owner and repository.');
  }
  if (!/^\d{1,10}$/.test(number)) {
    throw new ReproInputError('That GitHub URL has no issue number.');
  }
  return {
    provider: 'GITHUB',
    host,
    repo: `${owner}/${repo}`,
    key: number,
    isPullRequest: kind === 'pull',
  };
}

function linearRef(host: string, segments: string[]): IssueRef {
  // /workspace/issue/ENG-42/some-slug
  const index = segments.indexOf('issue');
  const key = index >= 0 ? (segments[index + 1] ?? '') : '';
  if (!LINEAR_KEY.test(key)) {
    throw new ReproInputError(
      'That Linear URL is not an issue link — it should look like https://linear.app/team/issue/ENG-42.',
    );
  }
  return { provider: 'LINEAR', host, repo: '', key, isPullRequest: false };
}

function jiraRef(host: string, segments: string[], selectedIssue: string | null): IssueRef {
  // /browse/QA-12, or a board URL carrying ?selectedIssue=QA-12.
  const browseIndex = segments.indexOf('browse');
  const fromPath = browseIndex >= 0 ? (segments[browseIndex + 1] ?? '') : '';
  const key = (fromPath || selectedIssue || '').trim().toUpperCase();

  if (!JIRA_KEY.test(key)) {
    throw new ReproInputError(
      `QAAI does not recognise that issue URL. Supported: ${SUPPORTED_SHAPES}.`,
    );
  }
  if (!host.includes('.')) {
    // A single-label name is an internal host. The route compares this against
    // the configured site and would refuse anyway; refusing here means the
    // caller gets a sentence about the URL instead of one about their config.
    throw new ReproInputError('That Jira URL does not name a public site.');
  }
  return { provider: 'JIRA', host, repo: '', key, isPullRequest: false };
}

// ─── The extracted report ────────────────────────────────────────────────────

export type SectionKey =
  | 'TITLE'
  | 'STEPS'
  | 'EXPECTED'
  | 'ACTUAL'
  | 'ENVIRONMENT'
  | 'ERRORS'
  | 'DESCRIPTION'
  | 'OTHER';

/** How the steps were written, which is how much to trust them. */
export type StepsFormat = 'ORDERED' | 'STEP_N' | 'GHERKIN' | 'BULLET' | 'INLINE' | 'LINES' | 'NONE';

export interface ReportEnvironment {
  browser: string | null;
  os: string | null;
  device: string | null;
  appVersion: string | null;
  /** As written: "staging", "prod", "uat". */
  envName: string | null;
  /** The environment section verbatim, when there was one. */
  raw: string | null;
}

export interface ExtractedReport {
  title: string | null;
  steps: string[];
  stepsFormat: StepsFormat;
  expected: string | null;
  actual: string | null;
  environment: ReportEnvironment;
  /** Absolute URLs, in the order they appeared. */
  urls: string[];
  /** Relative paths (`/checkout`), in the order they appeared. */
  paths: string[];
  selectors: string[];
  errorStrings: string[];
  /** Fenced blocks, verbatim — stack traces, logs, payloads. */
  codeBlocks: string[];
  /** Which conventions were actually found. */
  found: SectionKey[];
  /** 0–1. How much of the work the prose did; below ENRICH_BELOW_SCORE, ask a model. */
  structureScore: number;
  /** Prose that belonged to no section. The model still sees this. */
  narrative: string;
  /** Which fields a model supplied rather than the reporter. Empty here by construction. */
  enrichedFields: string[];
}

const EMPTY_ENVIRONMENT: ReportEnvironment = {
  browser: null,
  os: null,
  device: null,
  appVersion: null,
  envName: null,
  raw: null,
};

// ─── Section splitting ───────────────────────────────────────────────────────

interface Section {
  key: SectionKey;
  label: string;
  body: string;
  /** Index of the heading line, so "the first heading" can be identified. */
  order: number;
}

/**
 * Pull fenced blocks out before anything else looks at the text.
 *
 * A stack trace is the single richest thing in a bug report and also the single
 * most destructive thing to run a section parser over: jest prints
 * `Expected: 200 / Received: 500` inside its output, and treating those as
 * section headings truncates the real Expected section and replaces it with a
 * fragment of a diff. So fences come out first, are mined separately, and leave
 * a placeholder behind so surrounding steps keep their positions.
 */
function pullFences(text: string): { body: string; fences: string[] } {
  const fences: string[] = [];
  const take = (raw: string): string => {
    // Keeps FENCE_PLACEHOLDER below in step with what is written here.
    const content = raw.trim();
    if (content) fences.push(content.slice(0, MAX_FENCE_CHARS));
    return `[code block ${fences.length}]`;
  };

  let body = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, inner: string) => take(inner));
  // Jira's wiki markup, which is what a pasted Jira description actually uses.
  body = body.replace(/\{(code|noformat)(?::[^}]*)?\}([\s\S]*?)\{\1\}/gi, (_m, _k, inner: string) =>
    take(inner),
  );

  /*
   * An UNCLOSED fence still ends the prose.
   *
   * The balanced pass above has removed every matched pair, so an opener left
   * behind has no closer — which is exactly what a pasted 500 KB log looks like
   * after MAX_REPORT_CHARS truncates it mid-block. Left alone, the tail is not a
   * fence, so the section parser folds it into whatever step came last and the
   * generator is handed one "step" containing a quarter of a megabyte of stack
   * trace. Everything from the dangling opener to the end is the block.
   */
  const dangling = /(?:```|\{(?:code|noformat)(?::[^}]*)?\})[^\n]*\n?([\s\S]*)$/i.exec(body);
  if (dangling) {
    body = body.slice(0, dangling.index) + take(dangling[1] ?? '');
  }

  return { body, fences };
}

const HEADING_PATTERNS: RegExp[] = [
  /^#{1,6}\s*(.+?)\s*$/, // markdown
  /^h[1-6]\.\s*(.+?)\s*$/i, // jira wiki
  /^\*\*(.+?)\*\*\s*:?\s*$/, // **Steps to reproduce**
  /^__(.+?)__\s*:?\s*$/,
  /^([A-Za-z][\w /&'-]{1,40})\s*:\s*$/, // Steps to reproduce:
];

/** `Expected: the order confirms` — a heading and its content on one line. */
const INLINE_HEADING = /^\s*(?:[*_]{0,2})([A-Za-z][\w /&'-]{1,40})(?:[*_]{0,2})\s*:\s+(\S.*)$/;

/**
 * `Expected` alone on its own line — no marker of any kind.
 *
 * Two to four bare words, letters and spaces only. No digits, no punctuation,
 * no slashes: those are what separate a heading from a sentence that happens to
 * start a line. The caller additionally requires the words to classify as a
 * known field, so this pattern alone never starts a section.
 */
const BARE_HEADING = /^\s*([A-Za-z]+(?: [A-Za-z]+){0,3})\s*$/;

function headingOf(line: string): string | null {
  for (const pattern of HEADING_PATTERNS) {
    const match = pattern.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Map a heading to one of the fields the generator needs.
 *
 * Order is load-bearing: "Expected result" and "Actual result" both contain
 * "result", so the specific tests have to run before the generic one.
 */
export function classifySection(label: string): SectionKey {
  const l = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!l) return 'OTHER';

  /*
   * Every alternative below is plural-tolerant on purpose. `\bstep\b` does not
   * match "Steps", which is the single most common heading in the whole corpus:
   * a report headed `## Steps` fell through to OTHER, its numbered list was
   * never read as steps, and the plan item came out with an invented step and a
   * note apologising for it. Suffixes are cheap; a missed heading is not.
   */
  if (/\b(steps?|repro\w*|how to)\b/.test(l)) return 'STEPS';
  if (/\bexpect/.test(l) || l === 'should' || /\bshould happen\b/.test(l)) return 'EXPECTED';
  if (/\b(actual|observed|instead|current behaviou?rs?|what happens|results?|outcomes?)\b/.test(l)) {
    return 'ACTUAL';
  }
  if (/\b(environments?|env|browsers?|devices?|os|platforms?|versions?|builds?|system info)\b/.test(l)) {
    return 'ENVIRONMENT';
  }
  if (/\b(errors?|logs?|consoles?|stacks?|tracebacks?|outputs?)\b/.test(l)) return 'ERRORS';
  if (/\b(titles?|summar(?:y|ies)|issues?|bugs?|problems?)\b/.test(l)) return 'TITLE';
  if (/\b(descriptions?|contexts?|backgrounds?|notes?|details?|impacts?)\b/.test(l)) {
    return 'DESCRIPTION';
  }
  return 'OTHER';
}

function splitSections(body: string): { sections: Section[]; preamble: string } {
  const lines = body.split('\n');
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: { key: SectionKey; label: string; lines: string[]; order: number } | null = null;
  let order = 0;

  const flush = () => {
    if (!current) return;
    sections.push({
      key: current.key,
      label: current.label,
      body: current.lines.join('\n').trim(),
      order: current.order,
    });
    current = null;
  };

  for (const line of lines) {
    /*
     * Markdown puts the colon inside the emphasis as often as outside —
     * `**Expected:** the total updates` and `**Expected**: the total updates`
     * are the same sentence to a human and two different strings to a regex.
     * Detection runs against a de-emphasised copy so both forms find the same
     * label; the section body keeps whichever form the reporter wrote.
     */
    const probe = line.replace(/(\*\*|__)/g, '');

    const label = headingOf(line) ?? headingOf(probe);
    if (label !== null) {
      flush();
      current = { key: classifySection(label), label, lines: [], order: order++ };
      continue;
    }

    const inline = INLINE_HEADING.exec(probe);
    // Only treat `Foo: bar` as a heading when "Foo" is a field name we know.
    // Otherwise every sentence containing a colon starts a new section.
    if (inline?.[1] && inline[2]) {
      const key = classifySection(inline[1]);
      if (key !== 'OTHER') {
        flush();
        current = { key, label: inline[1].trim(), lines: [inline[2].trim()], order: order++ };
        continue;
      }
    }

    /*
     * A bare heading: `Expected` alone on a line, with no `#`, no bold and no
     * colon. Plain-text tickets — including the one this product prints in its
     * own placeholder — are written that way, and none of the patterns above
     * see them. The whole tail of the report then fell inside the last numbered
     * step, `expected` and `actual` came back null, and the generated test
     * asserted nothing but "the flow completes": the exact failure mode this
     * file exists to prevent, arrived at by a missing heading.
     *
     * The bar is deliberately high, because a false heading SPLITS a report and
     * is worse than a missed one. It must be a short run of bare words, with no
     * sentence punctuation, no digits and no path separators — so a step like
     * "Click the first result to open /products/2" (which contains "result",
     * and would otherwise classify as ACTUAL) can never qualify.
     */
    const bare = BARE_HEADING.exec(probe);
    if (bare?.[1]) {
      const key = classifySection(bare[1]);
      if (key !== 'OTHER') {
        flush();
        current = { key, label: bare[1].trim(), lines: [], order: order++ };
        continue;
      }
    }

    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  return { sections, preamble: preamble.join('\n').trim() };
}

function sectionBody(sections: Section[], key: SectionKey): string | null {
  const hits = sections.filter((s) => s.key === key && s.body);
  if (hits.length === 0) return null;
  return hits.map((s) => s.body).join('\n\n');
}

// ─── Steps ───────────────────────────────────────────────────────────────────

const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const STEP_N = /^\s*step\s*\d{1,3}\s*[:.)-]?\s*(.*)$/i;
/** Opens a Gherkin block. `And`/`But` continue one and are handled separately. */
const GHERKIN_OPEN = /^\s*((?:given|when|then)\b.*)$/i;
const GHERKIN_CONT = /^\s*((?:and|but)\b.*)$/i;
const BULLET = /^\s*[-*•·]\s+(.*)$/;
/** `1. Go to /cart 2. Click checkout` — a whole list crammed onto one line. */
const INLINE_ORDERED = /(?:^|\s)(\d{1,2})[.)]\s+/g;
/** What pullFences leaves behind. Never a step, and never part of one. */
const FENCE_PLACEHOLDER = /^\[code block \d+\]$/;

function tidyStep(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^[-*•·\s]+/, '')
    .trim()
    .slice(0, MAX_STEP_CHARS);
}

/**
 * Read an ordered list out of prose, in whichever of the five conventions the
 * reporter used. Continuation lines are folded into the step above them, which
 * is how a wrapped step in a Jira description actually looks.
 */
export function parseSteps(body: string): { steps: string[]; format: StepsFormat } {
  const lines = body.split('\n');
  const collected: string[] = [];
  /** One entry per step actually kept; the first is the convention in use. */
  const formats: StepsFormat[] = [];
  let inGherkin = false;

  const push = (text: string, f: StepsFormat) => {
    const step = tidyStep(text);
    if (!step) return;
    formats.push(f);
    collected.push(step);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    // A stack trace sat between two steps is evidence, not a step, and folding
    // its placeholder into the step above renames that step after a log file.
    if (FENCE_PLACEHOLDER.test(line.trim())) continue;

    const ordered = ORDERED.exec(line);
    if (ordered?.[2] !== undefined) {
      push(ordered[2], 'ORDERED');
      inGherkin = false;
      continue;
    }
    const stepN = STEP_N.exec(line);
    if (stepN?.[1] !== undefined) {
      push(stepN[1], 'STEP_N');
      inGherkin = false;
      continue;
    }
    const gherkin = GHERKIN_OPEN.exec(line);
    if (gherkin?.[1] !== undefined) {
      push(gherkin[1], 'GHERKIN');
      inGherkin = true;
      continue;
    }
    /*
     * `And` is a step only inside a Gherkin block. Outside one it is how a
     * wrapped sentence continues — "1. Open the cart page / and wait for it to
     * load" is one step, and reading the second line as a step of its own
     * produces a test that opens a page and then does nothing twice.
     */
    const cont = GHERKIN_CONT.exec(line);
    if (inGherkin && cont?.[1] !== undefined) {
      push(cont[1], 'GHERKIN');
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[1] !== undefined) {
      push(bullet[1], 'BULLET');
      inGherkin = false;
      continue;
    }

    // A continuation of the step above, not a step of its own.
    if (collected.length > 0) {
      const merged = tidyStep(`${collected[collected.length - 1]} ${line}`);
      collected[collected.length - 1] = merged;
      continue;
    }
  }

  /*
   * One "step" that still contains a numbered list is a list somebody typed on
   * a single line. The line matcher above swallowed it whole — `1. go to /cart
   * 2. click pay` looks like step 1 with a long body — so re-split it here
   * rather than handing the generator one step containing three actions.
   */
  const format: StepsFormat = formats[0] ?? 'NONE';
  if (collected.length === 1 && (format === 'ORDERED' || format === 'BULLET')) {
    const split = splitInlineOrdered(body);
    if (split.length >= 2) return { steps: split.slice(0, MAX_STEPS), format: 'INLINE' };
  }

  if (collected.length > 0) {
    return { steps: collected.slice(0, MAX_STEPS), format };
  }

  // No markers. Two fallbacks, both narrow enough not to turn a paragraph of
  // narrative into fifteen "steps" nobody wrote.
  const inline = splitInlineOrdered(body);
  if (inline.length >= 2) return { steps: inline.slice(0, MAX_STEPS), format: 'INLINE' };

  const nonEmpty = lines.map((l) => tidyStep(l)).filter(Boolean);
  if (nonEmpty.length >= 1 && nonEmpty.length <= 12) {
    return { steps: nonEmpty.slice(0, MAX_STEPS), format: 'LINES' };
  }

  return { steps: [], format: 'NONE' };
}

function splitInlineOrdered(body: string): string[] {
  const flat = body.replace(/\s+/g, ' ').trim();
  const marks: number[] = [];
  INLINE_ORDERED.lastIndex = 0;
  let match: RegExpExecArray | null;
  let expected = 1;
  while ((match = INLINE_ORDERED.exec(flat)) !== null) {
    // Only accept a run that actually counts up — otherwise "version 1. 2 GB"
    // and a price list both look like ordered lists.
    if (Number(match[1]) !== expected) continue;
    marks.push(match.index + (match[0].startsWith(' ') ? 1 : 0));
    expected += 1;
  }
  if (marks.length < 2) return [];

  const out: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const slice = flat.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    const step = tidyStep(slice.replace(/^\d{1,2}[.)]\s*/, ''));
    if (step) out.push(step);
  }
  return out;
}

// ─── Expected / actual ───────────────────────────────────────────────────────

const EXPECTED_INLINE =
  /(?:^|\n)\s*(?:[*_]{0,2})expected(?:\s+(?:result|behaviou?r|outcome))?(?:[*_]{0,2})\s*[:—-]\s*(.+)/i;
const ACTUAL_INLINE =
  /(?:^|\n)\s*(?:[*_]{0,2})(?:actual|observed|received|instead|but got)(?:\s+(?:result|behaviou?r|outcome))?(?:[*_]{0,2})\s*[:—-]\s*(.+)/i;
/** What a failing assertion prints. Mined from fences only, never from prose. */
const FENCE_EXPECTED = /^\s*expected\s*:\s*(.+)$/im;
const FENCE_ACTUAL = /^\s*(?:received|actual|got)\s*:\s*(.+)$/im;

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.replace(/\s+/g, ' ').slice(0, MAX_STEP_CHARS) : null;
}

/**
 * The first paragraph, not the first line.
 *
 * An "Expected" written as a wrapped sentence is one thought across three
 * lines, and taking only the first of them truncates the expectation halfway —
 * which then becomes the assertion, so the test asserts half a sentence.
 */
function firstParagraph(text: string | null): string | null {
  if (!text) return null;
  const lines = text.split('\n').map((l) => l.trim());
  const start = lines.findIndex(Boolean);
  if (start < 0) return null;

  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    // A blank line ends the thought; a code block is evidence, not prose.
    if (!line || FENCE_PLACEHOLDER.test(line)) break;
    out.push(line);
  }
  const joined = out.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, MAX_PROSE_CHARS) : null;
}

// ─── Environment ─────────────────────────────────────────────────────────────

const BROWSER =
  /\b(chrome|chromium|firefox|safari|edge|webkit|opera)\b(?:\s*(?:v(?:ersion)?\.?\s*)?(\d+(?:\.\d+)*))?/i;
const OS =
  /\b(windows(?:\s*\d+)?|mac\s*os\s*x?|macos|os\s*x|ubuntu|debian|fedora|linux|android|ipados|ios)\b(?:\s*(\d+(?:\.\d+)*))?/i;
const DEVICE = /\b(iphone(?:\s*\d+\s*\w*)?|ipad(?:\s*\w+)?|pixel\s*\d*|galaxy\s*\w+)\b/i;
const APP_VERSION = /\b(?:app\s*version|version|build|release)\s*[:v]?\s*(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/i;
const ENV_NAME =
  /\b(production|prod|staging|stage|pre-?prod|uat|qa|sandbox|demo|localhost|local|dev(?:elopment)?)\b/i;

function parseEnvironment(section: string | null, whole: string): ReportEnvironment {
  const pick = (pattern: RegExp, join: boolean): string | null => {
    for (const haystack of [section, whole]) {
      if (!haystack) continue;
      const m = pattern.exec(haystack);
      if (m?.[1]) {
        const value = join && m[2] ? `${m[1]} ${m[2]}` : m[1];
        return value.replace(/\s+/g, ' ').trim();
      }
    }
    return null;
  };

  return {
    browser: pick(BROWSER, true),
    os: pick(OS, true),
    device: pick(DEVICE, false),
    appVersion: pick(APP_VERSION, false),
    envName: pick(ENV_NAME, false),
    raw: section ? section.replace(/\s+\n/g, '\n').trim().slice(0, 600) : null,
  };
}

// ─── URLs, paths, selectors, errors ──────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const PATH_RE = /(?:^|[\s(`"'[])(\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%:{}-]*)*)/g;

/** Extensions and TLDs that make a `.token` a filename, not a CSS class. */
const NOT_A_CLASS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'zip', 'log', 'txt', 'md', 'yml', 'yaml', 'env',
  'py', 'rb', 'go', 'java', 'php', 'sh', 'sql', 'xml', 'csv',
]);

function uniqueCapped(values: Iterable<string>, cap = MAX_LIST): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const v = value.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    // Sentence punctuation clings to a pasted URL; a trailing `)` is usually a
    // markdown link closing rather than part of the path.
    const cleaned = match[0].replace(/[.,;:!?]+$/, '').replace(/\)+$/, '');
    if (cleaned.length > 4) found.push(cleaned);
  }
  return uniqueCapped(found);
}

export function extractPaths(text: string): string[] {
  const found: string[] = [];
  // Strip absolute URLs first so their pathnames are not counted twice.
  const withoutUrls = text.replace(URL_RE, ' ');
  for (const match of withoutUrls.matchAll(PATH_RE)) {
    const path = (match[1] ?? '').replace(/[.,;:!?]+$/, '');
    if (path.length < 2 || path.length > 200) continue;
    if (path.includes('//')) continue;
    found.push(path);
  }
  return uniqueCapped(found);
}

export function extractSelectors(text: string): string[] {
  const found: string[] = [];

  const patterns: RegExp[] = [
    /\[data-test(?:id|-id)?\s*=\s*["']?[^\]"'\s]+["']?\]/gi,
    /\bdata-test(?:id|-id)?\s*=\s*["'][^"']+["']/gi,
    /\bgetBy(?:Role|TestId|Label|Text|Placeholder|Title|AltText)\([^)\n]{0,200}\)/g,
    /\b(?:page|cy|driver)\.(?:locator|get|find|querySelector)\([^)\n]{0,200}\)/g,
    /\b[a-z]{1,12}\[[a-z-]{1,30}\s*=\s*["']?[^\]"'\s]{1,60}["']?\]/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }

  // `#id` — but not `#1234`, which is an issue reference in every tracker.
  for (const match of text.matchAll(/(?:^|[\s`"'(>])(#[A-Za-z][\w-]{2,60})\b/g)) {
    if (match[1]) found.push(match[1]);
  }

  // `.class` — but not a file extension, a TLD, or a sentence's full stop
  // followed by a word (which is why a space may not precede the dot).
  for (const match of text.matchAll(/(?:^|[\s`"'(>])(\.[A-Za-z][\w-]{2,60})(?=[\s`"')\],;:.!?]|$)/g)) {
    const token = match[1]!;
    if (NOT_A_CLASS.has(token.slice(1).toLowerCase())) continue;
    found.push(token);
  }

  return uniqueCapped(found);
}

const NAMED_ERROR = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b(?:\s*:\s*([^\n]{0,200}))?/g;
const HTTP_STATUS = /\b(?:http\s*|status\s*(?:code\s*)?|returned\s*|responded\s+with\s*)(\d{3})\b/gi;
const STATUS_PHRASE =
  /\b(\d{3})\s+(internal server error|bad request|not found|unauthorized|forbidden|service unavailable|bad gateway|gateway timeout|conflict|unprocessable entity)\b/gi;
const QUOTED = /"([^"\n]{4,120})"|“([^”\n]{4,120})”/g;
/** Words that make a nearby quoted phrase a message rather than a noun. */
const ERROR_CUE =
  /\b(error|errors|fail|failed|failing|failure|message|shows?|showed|says?|said|displays?|displayed|toast|alert|banner|popup|warning|exception|crash(?:e[sd])?|reads?)\b/i;

/**
 * The strings that say WHY it broke. These are the highest-value output of the
 * whole extractor: they are what the duplicate check matches on, and what
 * `reproVerdict` holds the run's own failure message against to decide whether
 * a red test is red for the reported reason or for an unrelated one.
 *
 * Named errors and HTTP statuses identify themselves and are taken from
 * anywhere. A QUOTED phrase does not: the steps of a real ticket are full of
 * quoted product names, button labels and field names, and harvesting those as
 * "the reported error" is not a cosmetic problem. Observed on the demo store: a
 * report quoting `"Pour-over kettle"` in step 2 produced that string as an
 * error, the generated test's own locator echoed it back inside a timeout
 * message, and a run that failed because a BUTTON WAS MISSING was reported as
 * "the bug reproduces, confirmed". A quoted phrase therefore counts only when
 * something within a line of it says it is a message.
 */
export function extractErrorStrings(text: string, codeBlocks: string[] = []): string[] {
  const found: string[] = [];
  const haystacks = [text, ...codeBlocks];

  for (const haystack of haystacks) {
    for (const match of haystack.matchAll(NAMED_ERROR)) {
      const message = match[2]?.trim();
      found.push((message ? `${match[1]}: ${message}` : match[1]!).slice(0, MAX_ERROR_CHARS));
    }
    for (const match of haystack.matchAll(STATUS_PHRASE)) {
      found.push(`${match[1]} ${match[2]}`);
    }
    for (const match of haystack.matchAll(HTTP_STATUS)) {
      const code = Number(match[1]);
      if (code >= 400 && code <= 599) found.push(`HTTP ${match[1]}`);
    }
  }

  // Only from the prose: quoting inside a stack trace is usually just JSON.
  for (const match of text.matchAll(QUOTED)) {
    const quoted = (match[1] ?? match[2] ?? '').trim();
    if (!quoted.includes(' ') || quoted.startsWith('http')) continue;
    const context = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
    if (!ERROR_CUE.test(context.replace(quoted, ' '))) continue;
    found.push(quoted.slice(0, MAX_ERROR_CHARS));
  }

  return uniqueCapped(found);
}

// ─── The extractor ───────────────────────────────────────────────────────────

/** Weights sum to 1. Steps dominate because steps are what a test is made of. */
const SCORE_WEIGHTS: Array<[SectionKey | 'URLS' | 'SELECTORS', number]> = [
  ['STEPS', 0.4],
  ['EXPECTED', 0.2],
  ['ACTUAL', 0.15],
  ['TITLE', 0.1],
  ['URLS', 0.08],
  ['ERRORS', 0.04],
  ['ENVIRONMENT', 0.03],
];

/**
 * Read a pasted ticket into the fields a test is built from.
 *
 * Pure and total: any string produces a report, and an empty one produces an
 * empty report rather than an exception. The caller decides what a thin report
 * means — this function's only job is to never claim more than it found, which
 * is what `found` and `structureScore` are for.
 */
export function extractBugReport(raw: string): ExtractedReport {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').slice(0, MAX_REPORT_CHARS);
  if (!text.trim()) {
    return {
      title: null,
      steps: [],
      stepsFormat: 'NONE',
      expected: null,
      actual: null,
      environment: { ...EMPTY_ENVIRONMENT },
      urls: [],
      paths: [],
      selectors: [],
      errorStrings: [],
      codeBlocks: [],
      found: [],
      structureScore: 0,
      narrative: '',
      enrichedFields: [],
    };
  }

  const { body, fences } = pullFences(text);
  const { sections, preamble } = splitSections(body);
  const found = new Set<SectionKey>();

  // Steps: the section if there is one, otherwise an ordered list anywhere in
  // the ticket. A reporter who wrote "1. 2. 3." without a heading still wrote
  // steps, and refusing to see them is the difference between a usable test and
  // a model guessing.
  const stepsSection = sectionBody(sections, 'STEPS');
  let parsed = stepsSection ? parseSteps(stepsSection) : { steps: [], format: 'NONE' as StepsFormat };
  if (parsed.steps.length === 0) {
    // Only a NUMBERED or Gherkin list counts when it was found outside a steps
    // heading. A bare bullet list anywhere in a ticket is far more often an
    // environment table or a list of affected accounts, and turning one into
    // "steps to reproduce" produces a test of something nobody described.
    const anywhere = parseSteps(body);
    const trustworthy = anywhere.format === 'ORDERED' || anywhere.format === 'STEP_N' || anywhere.format === 'GHERKIN';
    if (anywhere.steps.length >= 2 && trustworthy) parsed = anywhere;
  }
  if (parsed.steps.length > 0) found.add('STEPS');

  const expectedSection = sectionBody(sections, 'EXPECTED');
  const actualSection = sectionBody(sections, 'ACTUAL');
  const expected =
    firstParagraph(expectedSection) ??
    firstLine(EXPECTED_INLINE.exec(body)?.[1] ?? null) ??
    firstLine(fences.map((f) => FENCE_EXPECTED.exec(f)?.[1] ?? '').find(Boolean) ?? null);
  const actual =
    firstParagraph(actualSection) ??
    firstLine(ACTUAL_INLINE.exec(body)?.[1] ?? null) ??
    firstLine(fences.map((f) => FENCE_ACTUAL.exec(f)?.[1] ?? '').find(Boolean) ?? null);
  if (expected) found.add('EXPECTED');
  if (actual) found.add('ACTUAL');

  const environmentSection = sectionBody(sections, 'ENVIRONMENT');
  const environment = parseEnvironment(environmentSection, body);
  if (environmentSection || environment.browser || environment.os || environment.envName) {
    found.add('ENVIRONMENT');
  }

  const title = pickTitle(sections, preamble, body);
  if (title) found.add('TITLE');

  const urls = extractUrls(text);
  const paths = extractPaths(body);
  const selectors = extractSelectors(text);
  /*
   * The steps are excluded from the error scan.
   *
   * Steps are where a reporter quotes product names, button labels and field
   * names — "Add the \"Ceramic mug\" to the cart" — and none of those is an
   * error, however error-shaped the sentence around them looks. What the
   * reproduction is HELD AGAINST later has to come from the sections that
   * describe the failure, or a red run gets confirmed against a noun.
   */
  const errorBearing = sections
    .filter((s) => s.key !== 'STEPS')
    .map((s) => s.body)
    .concat(preamble)
    .join('\n\n');
  const errorStrings = extractErrorStrings(errorBearing || body, fences);
  if (errorStrings.length > 0 || fences.length > 0) found.add('ERRORS');

  const narrative = [
    preamble,
    ...sections.filter((s) => s.key === 'DESCRIPTION' || s.key === 'OTHER').map((s) => s.body),
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_NARRATIVE);
  if (narrative) found.add('DESCRIPTION');

  const score = SCORE_WEIGHTS.reduce((total, [key, weight]) => {
    const present =
      key === 'URLS'
        ? urls.length > 0 || paths.length > 0
        : key === 'SELECTORS'
          ? selectors.length > 0
          : found.has(key);
    return present ? total + weight : total;
  }, 0);

  return {
    title,
    steps: parsed.steps,
    stepsFormat: parsed.format,
    expected,
    actual,
    environment,
    urls,
    paths,
    selectors,
    errorStrings,
    codeBlocks: fences,
    found: [...found],
    structureScore: Math.round(score * 100) / 100,
    narrative,
    enrichedFields: [],
  };
}

/** A heading that is JUST a field name; anything else is already the title. */
const BARE_TITLE_LABEL = /^(the\s+)?(title|summary|issue|bug|problem)$/;

function pickTitle(sections: Section[], preamble: string, body: string): string | null {
  const explicit = sections.find((s) => s.key === 'TITLE');
  if (explicit) {
    /*
     * "Summary: checkout hangs" and "## Bug: checkout hangs on Safari" both
     * classify as TITLE and mean opposite things about where the title is. When
     * the heading is bare — just the word "Summary" — the title is underneath
     * it. When the heading carries the sentence, the heading IS the title, and
     * reading the body instead would title the ticket with its first paragraph.
     */
    const bare = BARE_TITLE_LABEL.test(explicit.label.toLowerCase().replace(/[^a-z ]+/g, '').trim());
    const candidate = bare ? (firstLine(explicit.body) ?? explicit.label) : explicit.label;
    if (candidate) return candidate.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  }

  // The first heading of a ticket is its title even when it names no field —
  // "## Checkout hangs on Safari" is the summary, not a section.
  const firstHeading = [...sections].sort((a, b) => a.order - b.order)[0];
  if (firstHeading && (firstHeading.key === 'OTHER' || firstHeading.key === 'DESCRIPTION')) {
    return firstHeading.label.slice(0, MAX_TITLE);
  }

  const fromPreamble = firstLine(preamble);
  if (fromPreamble) return fromPreamble.slice(0, MAX_TITLE);

  return firstLine(body)?.slice(0, MAX_TITLE) ?? null;
}

// ─── Flow-map matching ───────────────────────────────────────────────────────

export type MatchKind = 'EXACT' | 'PARAMETERISED' | 'NORMALISED' | 'FUZZY' | 'NONE';

export interface RouteMatch {
  /** The URL or path as the reporter wrote it. */
  reported: string;
  /** The flow map's spelling of the route, or null when nothing matched. */
  route: string | null;
  nodeId: string | null;
  how: MatchKind;
  /** True when an absolute URL pointed at a different origin than the environment. */
  offEnvironment: boolean;
}

export interface FlowMatchResult {
  matches: RouteMatch[];
  /** Where the generated test should start. Null means "no idea — use baseUrl". */
  startRoute: string | null;
  nodeIds: string[];
  feature: string | null;
  warnings: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID = /^c[a-z0-9]{20,}$/i;
const HEX24 = /^[0-9a-f]{24}$/i;

/** `/orders/9f31/items` → `/orders/:id/items`, the flow map's own vocabulary. */
export function collapseIds(path: string): string {
  return (
    '/' +
    path
      .split('/')
      .filter(Boolean)
      .map((segment) =>
        /^\d+$/.test(segment) || UUID.test(segment) || CUID.test(segment) || HEX24.test(segment)
          ? ':id'
          : segment,
      )
      .join('/')
  );
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** A flow-map route with `:params` becomes a matcher for concrete paths. */
function routeMatcher(route: string): RegExp {
  const escaped = route
    .split('/')
    .map((segment) =>
      /^[:{*]/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`),
    )
    .join('/');
  return new RegExp(`^${escaped}/?$`, 'i');
}

function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${normaliseHost(parsed.hostname)}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}

/**
 * Point the reporter's URLs at routes that actually exist.
 *
 * The reason this is not optional: a reporter writes the URL they remember, or
 * the one from a bookmark, or one from a different environment entirely. A test
 * generated straight from it navigates somewhere that 404s, fails for that
 * reason, and looks exactly like a successful reproduction. Matching against the
 * crawl is what keeps a red test honest — and every case where the match failed
 * comes back as a warning rather than being silently papered over.
 */
export function matchFlowMap(extracted: ExtractedReport, flowMap: FlowMap | null): FlowMatchResult {
  const warnings: string[] = [];
  const reported = [...extracted.urls, ...extracted.paths];

  if (!flowMap || flowMap.nodes.length === 0) {
    warnings.push(
      'No flow map is available for this project, so the test starts from the environment base URL ' +
        'and every route in it comes from the bug report. Run the Explorer to fix that.',
    );
    return {
      matches: reported.map((r) => ({
        reported: r,
        route: null,
        nodeId: null,
        how: 'NONE',
        offEnvironment: false,
      })),
      startRoute: firstPath(reported),
      nodeIds: [],
      feature: null,
      warnings,
    };
  }

  const baseOrigin = originOf(flowMap.baseUrl);
  const matches: RouteMatch[] = [];
  const offHosts = new Set<string>();

  for (const item of reported) {
    const absolute = /^https?:\/\//i.test(item);
    const origin = absolute ? originOf(item) : null;
    const offEnvironment = Boolean(absolute && origin && baseOrigin && origin !== baseOrigin);
    if (offEnvironment && origin) offHosts.add(origin);

    const path = pathOf(item);
    if (!path) continue;

    const match = bestNode(path, extracted, flowMap);
    matches.push({
      reported: item,
      route: match?.route ?? null,
      nodeId: match?.id ?? null,
      how: match?.how ?? 'NONE',
      offEnvironment,
    });
  }

  for (const origin of offHosts) {
    warnings.push(
      `The report points at ${origin} but this environment is ${flowMap.baseUrl}. ` +
        'The test runs against the environment; if the bug only happens on the reported host, it will not reproduce here.',
    );
  }

  const unmatched = matches.filter((m) => m.how === 'NONE').map((m) => m.reported);
  if (unmatched.length > 0) {
    warnings.push(
      `Nothing in flow map v${flowMap.version} serves ${unmatched.join(', ')}. ` +
        'Either the reporter is describing a route that has moved, or the crawl is stale — check the first step before trusting a failure.',
    );
  }
  if (flowMap.truncatedReason) {
    warnings.push(
      `Flow map v${flowMap.version} is incomplete (${flowMap.truncatedReason}), so a missing route may just be a route the Explorer never reached.`,
    );
  }

  const matched = matches.find((m) => m.route);
  const startRoute = matched?.route ?? firstPath(reported);
  const nodeIds = uniqueCapped(matches.map((m) => m.nodeId).filter((id): id is string => !!id), 10);

  const feature =
    flowMap.features.find((f) => nodeIds.some((id) => f.nodeIds.includes(id)))?.name ?? null;

  return { matches, startRoute, nodeIds, feature, warnings };
}

function pathOf(item: string): string | null {
  if (item.startsWith('/')) return stripTrailingSlash(item.split(/[?#]/)[0] ?? item);
  try {
    return stripTrailingSlash(new URL(item).pathname);
  } catch {
    return null;
  }
}

function firstPath(reported: string[]): string | null {
  for (const item of reported) {
    const path = pathOf(item);
    if (path && path !== '/') return path;
  }
  return reported.length > 0 ? (pathOf(reported[0]!) ?? null) : null;
}

function bestNode(
  path: string,
  extracted: ExtractedReport,
  flowMap: FlowMap,
): { id: string; route: string; how: MatchKind } | null {
  const lower = path.toLowerCase();
  const collapsed = collapseIds(path).toLowerCase();

  for (const node of flowMap.nodes) {
    if (stripTrailingSlash(node.route).toLowerCase() === lower) {
      return { id: node.id, route: node.route, how: 'EXACT' };
    }
  }
  for (const node of flowMap.nodes) {
    if (node.route.includes(':') && routeMatcher(stripTrailingSlash(node.route)).test(path)) {
      return { id: node.id, route: node.route, how: 'PARAMETERISED' };
    }
  }
  for (const node of flowMap.nodes) {
    if (stripTrailingSlash(node.route).toLowerCase() === collapsed) {
      return { id: node.id, route: node.route, how: 'NORMALISED' };
    }
  }

  // Last resort: the reporter's path shares vocabulary with a node's route or
  // title. Two shared words is a weak signal, so it is reported as FUZZY and the
  // caller can show it as "we guessed".
  const words = new Set([
    ...tokensOf(path.replace(/[/-]/g, ' ')),
    ...tokensOf(extracted.title ?? ''),
  ]);
  let best: { id: string; route: string; score: number } | null = null;
  for (const node of flowMap.nodes) {
    const hay = tokensOf(`${node.route.replace(/[/-]/g, ' ')} ${node.title}`);
    let score = 0;
    for (const word of words) if (hay.has(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) {
      best = { id: node.id, route: node.route, score };
    }
  }
  return best && best.score >= 2 ? { id: best.id, route: best.route, how: 'FUZZY' } : null;
}

// ─── Duplicate detection ─────────────────────────────────────────────────────

export interface CoveringTest {
  id: string;
  name: string;
  filePath: string;
  feature: string | null;
  code: string;
  tags: string[];
}

export interface DuplicateCandidate {
  testId: string;
  name: string;
  filePath: string;
  /** 0–1. */
  score: number;
  /** Why it scored. Shown to the user; also the second-signal requirement. */
  reasons: string[];
}

export interface DuplicateReport {
  candidates: DuplicateCandidate[];
  /** The one strong enough to stop generation. Null means "write the test". */
  duplicateOf: DuplicateCandidate | null;
  threshold: number;
}

/**
 * Is this bug already covered?
 *
 * This is the one thing in the file that can SUPPRESS work, so it follows the
 * house rule for anything that suppresses a signal: it fails OPEN. A scoring
 * error, a thin report, or a single weak signal all resolve to "no duplicate" —
 * which means QAAI writes the test. The failure mode of being wrong that way is
 * a redundant test somebody deletes. The failure mode of the other way is a bug
 * that was never reproduced because we told the user it already had a test.
 *
 * `duplicateOf` therefore needs BOTH a score over the threshold and at least two
 * independent reasons. A title that happens to share the word "checkout" with
 * forty tests is not evidence.
 */
export function findCoveringTests(
  extracted: ExtractedReport,
  match: FlowMatchResult,
  tests: readonly CoveringTest[],
): DuplicateReport {
  const candidates: DuplicateCandidate[] = [];

  const routes = uniqueCapped(
    [match.startRoute, ...match.matches.map((m) => m.route)].filter((r): r is string => !!r),
    5,
  );
  const reportWords = tokensOf(
    `${extracted.title ?? ''} ${extracted.steps.join(' ')} ${extracted.expected ?? ''}`,
  );
  const distinctiveErrors = extracted.errorStrings.filter((e) => e.length >= 8 && e.length <= 120);

  for (const test of tests) {
    try {
      const reasons: string[] = [];
      let score = 0;
      const code = test.code ?? '';

      const routeHit = routes.find((route) => code.includes(`'${route}'`) || code.includes(`"${route}"`));
      if (routeHit) {
        score += 0.35;
        reasons.push(`navigates to ${routeHit}`);
      }

      const selectorHits = extracted.selectors.filter((selector) =>
        code.includes(selectorCore(selector)),
      );
      if (selectorHits.length > 0) {
        // A shared `#promo-apply` is far stronger evidence than a shared word:
        // element ids are specific to one screen and one feature.
        score += Math.min(0.35, 0.25 + (selectorHits.length - 1) * 0.1);
        reasons.push(`uses ${selectorHits.slice(0, 3).join(', ')}`);
      }

      /*
       * Containment, not Jaccard.
       *
       * A test is called "Checkout hangs when a promo code is applied" — seven
       * words. A bug report is two hundred. Jaccard divides by the union, so a
       * test name entirely contained in the report scores 0.03 and the check
       * never fires. What is being asked is not "are these the same size text"
       * but "does the report say everything this test's name says", and that is
       * containment against the smaller side. The file path joins the test's
       * side because `tests/checkout/promo.spec.ts` is a sentence too.
       */
      const testWords = tokensOf(
        `${test.name} ${test.feature ?? ''} ${test.filePath.replace(/[/.]/g, ' ')} ${test.tags.join(' ')}`,
      );
      const overlap = containment(testWords, reportWords);
      if (overlap > 0.35) {
        score += 0.3 * overlap;
        reasons.push(
          `its name and path cover the same words as the report (${Math.round(overlap * 100)}%)`,
        );
      }

      const errorHit = distinctiveErrors.find((error) => code.includes(error));
      if (errorHit) {
        score += 0.2;
        reasons.push(`asserts on "${errorHit.slice(0, 60)}"`);
      }

      if (match.feature && test.feature && match.feature === test.feature) {
        score += 0.1;
        reasons.push(`same feature (${test.feature})`);
      }

      if (reasons.length > 0) {
        candidates.push({
          testId: test.id,
          name: test.name,
          filePath: test.filePath,
          score: Math.round(Math.min(1, score) * 100) / 100,
          reasons,
        });
      }
    } catch {
      // Fail open, per test: one unscoreable test must not suppress the report
      // and must not suppress generation either.
      continue;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0] ?? null;
  const duplicateOf =
    top && top.score >= DUPLICATE_THRESHOLD && top.reasons.length >= 2 ? top : null;

  return { candidates: candidates.slice(0, 5), duplicateOf, threshold: DUPLICATE_THRESHOLD };
}

/** The part of a selector that survives translation into another locator API. */
function selectorCore(selector: string): string {
  const quoted = /["']([^"']{2,80})["']/.exec(selector);
  if (quoted?.[1]) return quoted[1];
  return selector.replace(/^[#.]/, '');
}

/** What fraction of the smaller vocabulary the two texts share. */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// ─── The plan item ───────────────────────────────────────────────────────────

export type ReproSource =
  | { kind: 'TEXT' }
  | { kind: 'ISSUE'; provider: IssueProvider; key: string; url: string };

export interface ReproPlan {
  item: PlanItem;
  /** Everything the caller should show a human before trusting the test. */
  notes: string[];
}

const SEVERE = /\b(crash|crashe[sd]|data loss|lost|corrupt|cannot|can't|unable|blocked|charged twice|double)\b/i;

/**
 * Assemble the plan item the Generator turns into code.
 *
 * The assertions are the whole point and they are built by INVERSION: a test
 * whose assertions describe what the reporter SAW would pass against the broken
 * app and prove nothing. So the assertion is always the expected behaviour, and
 * the observed behaviour goes in only as context telling the generator what the
 * failure should look like.
 *
 * When the report has no "Expected", the expectation is derived from the actual
 * by negation and the derivation is put in `notes` — a negated assertion is a
 * weaker test and the person reading it deserves to know which kind they got.
 */
export function buildReproPlanItem(args: {
  extracted: ExtractedReport;
  match: FlowMatchResult;
  source: ReproSource;
  id: string;
}): ReproPlan {
  const { extracted, match, source, id } = args;
  const notes: string[] = [...match.warnings];

  const sourceLabel =
    source.kind === 'ISSUE' ? `${source.provider} ${source.key}` : 'a pasted bug report';

  const title = (extracted.title ?? `Reproduction of ${sourceLabel}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);

  const steps: string[] = [];
  const navigatesAlready = extracted.steps.some((step) =>
    /\b(go to|open|navigate|visit|browse)\b/i.test(step),
  );
  if (match.startRoute && !navigatesAlready) {
    steps.push(`Open ${match.startRoute}`);
  }
  for (const step of extracted.steps) {
    if (steps.length >= MAX_STEPS) break;
    steps.push(step);
  }

  if (steps.length === 0) {
    // planItemSchema requires at least one step, and a fabricated one would be
    // indistinguishable from a reported one. Say plainly that it is a stand-in.
    steps.push(
      match.startRoute
        ? `Open ${match.startRoute} and follow the description below`
        : 'Follow the description below',
    );
    notes.push(
      'The report contained no steps to reproduce in any recognised form, so the steps in this test ' +
        'were inferred from its prose. Check them before trusting a pass or a failure.',
    );
  } else if (extracted.stepsFormat === 'LINES') {
    notes.push(
      'The steps were read as one-per-line from unnumbered prose, so their order and boundaries are a guess.',
    );
  }

  const assertions: string[] = [];
  if (extracted.expected) {
    assertions.push(
      `Assert the expected behaviour the report describes: ${extracted.expected}`,
    );
  } else if (extracted.actual) {
    assertions.push(
      `The report gives no "expected", only what happens. Assert the negation: the application must NOT ${lowerFirst(extracted.actual)}`,
    );
    notes.push(
      'No expected result was stated, so the assertion is the negation of the reported symptom. ' +
        'A negated assertion passes for many reasons — replace it with the real expectation before this test gates anything.',
    );
  } else {
    assertions.push(
      'Assert that the flow above completes without an error and reaches its normal end state',
    );
    notes.push(
      'The report stated neither an expected nor an actual result, so the assertion is generic. ' +
        'This test is unlikely to reproduce anything specific.',
    );
  }

  if (extracted.actual && extracted.expected) {
    assertions.push(
      `This assertion must FAIL while the bug is live — the report says the application instead ${lowerFirst(extracted.actual)}`,
    );
  }
  for (const error of extracted.errorStrings.slice(0, 3)) {
    if (assertions.length >= MAX_ASSERTIONS) break;
    assertions.push(`The reported failure surfaces as: ${error.slice(0, 200)}`);
  }

  const environmentLine = describeEnvironment(extracted.environment);
  const rationale = [
    `Reproduction requested from ${sourceLabel}.`,
    extracted.actual ? `Reported symptom: ${extracted.actual}` : null,
    environmentLine ? `Reported on ${environmentLine}.` : null,
    'This test exists to FAIL until the bug is fixed: assert the expected behaviour, never the broken one.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, MAX_RATIONALE);

  const feature = (match.feature ?? featureFromRoute(match.startRoute) ?? 'Bug reproduction').slice(
    0,
    MAX_FEATURE,
  );

  const severe =
    SEVERE.test(`${extracted.title ?? ''} ${extracted.actual ?? ''} ${extracted.narrative}`) ||
    extracted.errorStrings.some((e) => /\b5\d\d\b/.test(e));
  const priority: Priority = severe ? 'CRITICAL_PATH' : 'IMPORTANT';

  if (extracted.selectors.length === 0 && extracted.urls.concat(extracted.paths).some((u) => u.includes('/api/'))) {
    notes.push(
      'This reads like an API bug (endpoints, no UI selectors) but the test is generated as E2E — ' +
        'an API test needs a request chain in its spec, which this endpoint does not build.',
    );
  }

  return {
    item: {
      id,
      title,
      rationale,
      feature,
      priority,
      testType: 'E2E',
      steps: steps.slice(0, MAX_STEPS),
      assertions: assertions.slice(0, MAX_ASSERTIONS),
      journeyId: null,
      authProfileId: null,
    },
    notes: uniqueCapped(notes, 12),
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function describeEnvironment(env: ReportEnvironment): string | null {
  const parts = [env.browser, env.os, env.device, env.envName, env.appVersion].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

function featureFromRoute(route: string | null): string | null {
  if (!route) return null;
  const first = route.split('/').filter(Boolean)[0];
  if (!first || first.startsWith(':')) return null;
  return first.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// ─── The verdict ─────────────────────────────────────────────────────────────

export type ReproOutcome = 'REPRODUCED' | 'NOT_REPRODUCED' | 'INCONCLUSIVE';

export interface ReproVerdict {
  outcome: ReproOutcome;
  /** One sentence, safe to put straight in front of a user. */
  headline: string;
  detail: string;
  /** The reported error string the run's own failure echoed, when one did. */
  matchedReportedError: string | null;
  /** True only when the run failed AND failed for the reported reason. */
  confirmed: boolean;
}

/**
 * Decide whether the generated test actually reproduced the bug.
 *
 * The rule that this function exists to enforce: **a reproduction that passes
 * has not reproduced anything.** A PASSED run is reported as NOT_REPRODUCED, in
 * those words, with no softening — the failure mode this prevents is a user
 * closing a ticket because "QAAI wrote a test for it" when the test is green
 * against the broken app and proves the opposite of what they think.
 *
 * A red run is not automatically a win either. A test that fails because the
 * first `goto` 404s, or because a login fixture is missing, is red for a reason
 * that has nothing to do with the report. So the run's own error message is held
 * against the error strings the reporter gave, and the difference between "it
 * failed" and "it failed with the reported error" is reported rather than
 * flattened.
 */
export function reproVerdict(args: {
  status: TestResultStatus | null;
  errorMessage: string | null;
  extracted: ExtractedReport;
}): ReproVerdict {
  const { status, errorMessage, extracted } = args;

  if (status === null) {
    return {
      outcome: 'INCONCLUSIVE',
      headline: 'The reproduction has not finished running.',
      detail:
        'No result has been recorded for this test yet. Until it has, nothing is known about whether the bug reproduces.',
      matchedReportedError: null,
      confirmed: false,
    };
  }

  if (status === 'PASSED') {
    return {
      outcome: 'NOT_REPRODUCED',
      headline: 'This test PASSES against the current app — the bug was NOT reproduced.',
      detail:
        'A reproduction that passes has reproduced nothing. Either the steps do not reach the broken path, the ' +
        'assertion does not check the thing that is broken, this environment is not where the bug happens, or the ' +
        'bug is already fixed here. Do not treat this test as covering the report until it has been seen to fail.',
      matchedReportedError: null,
      confirmed: false,
    };
  }

  if (status === 'FAILED' || status === 'TIMED_OUT') {
    const matched = matchReportedError(errorMessage, extracted.errorStrings);
    if (matched) {
      return {
        outcome: 'REPRODUCED',
        headline: `The test fails with the reported error — the bug reproduces (${status}).`,
        detail: `The run's own failure echoes "${matched}", which the bug report also names. That is a reproduction of the reported failure, not merely a red test.`,
        matchedReportedError: matched,
        confirmed: true,
      };
    }
    /*
     * "Failed with a different error" and "the report gave nothing to compare
     * against" are not the same statement, and reporting the first when the
     * second is true reads as an accusation against a test that is fine. A
     * numeric bug — a total that is wrong by the price of a line — names no
     * error text at all, and that is the most common shape of report there is.
     */
    if (extracted.errorStrings.length === 0) {
      return {
        outcome: 'REPRODUCED',
        headline: `The test fails against the current app (${status}), which is what a reproduction looks like.`,
        detail:
          'The report quoted no error text, so there was nothing to hold the failure against — the failure matches the ' +
          "assertion built from the report's expected result, and nothing more than that has been checked. Read the " +
          'failure once before filing it.',
        matchedReportedError: null,
        confirmed: false,
      };
    }

    return {
      outcome: 'REPRODUCED',
      headline: `The test fails against the current app (${status}) — but not with the error the report described.`,
      detail:
        'A failing test is what a reproduction should look like, but this one failed for a reason the report does not ' +
        'mention. Check the failure before filing it: a broken first step, a missing fixture or a wrong route fails ' +
        'exactly like a real bug and proves nothing about it.',
      matchedReportedError: null,
      confirmed: false,
    };
  }

  if (status === 'FLAKY') {
    return {
      outcome: 'INCONCLUSIVE',
      headline: 'The test failed and then passed on retry — that is a flake, not a reproduction.',
      detail:
        'An intermittent result cannot confirm or deny the report. Either the bug is itself intermittent, in which case ' +
        'the test needs to pin the condition that triggers it, or the test is unstable and needs fixing before it can say anything.',
      matchedReportedError: null,
      confirmed: false,
    };
  }

  return {
    outcome: 'INCONCLUSIVE',
    headline: 'The reproduction did not execute.',
    detail:
      (errorMessage ?? 'The runner reported the test as skipped.') +
      ' Nothing was evaluated, so the report is neither confirmed nor denied.',
    matchedReportedError: null,
    confirmed: false,
  };
}

/**
 * Did the run fail with something the reporter named?
 *
 * Compared case-insensitively on a normalised form, because the same message
 * arrives from a browser console, a screenshot transcription and a Playwright
 * error with three different amounts of whitespace.
 */
export function matchReportedError(
  errorMessage: string | null,
  reported: readonly string[],
): string | null {
  if (!errorMessage) return null;
  const haystack = failureText(errorMessage).replace(/\s+/g, ' ').toLowerCase();
  for (const candidate of reported) {
    const needle = candidate.replace(/\s+/g, ' ').toLowerCase().trim();
    // Short needles ("HTTP 500") match too much of a stack trace to be evidence
    // on their own, but they are still the most common thing a reporter gives,
    // so they count when they appear as a whole token.
    if (needle.length < 4) continue;
    if (needle.length <= 10) {
      if (new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`).test(haystack)) {
        return candidate;
      }
      continue;
    }
    if (haystack.includes(needle)) return candidate;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

/**
 * The part of a failure that came from the APPLICATION, with the part that came
 * from the test removed.
 *
 * This is not tidying. A test generated from a bug report is built out of that
 * report's own words, so its locators contain them — and Playwright prints the
 * locator it was waiting for, plus a whole call log, inside the failure message.
 * Matching the report against that is circular: it confirms every timeout as
 * "failed with the reported error", including the timeout that means the very
 * first step never found its button. Observed exactly that way on the demo
 * store before this existed.
 */
export function failureText(errorMessage: string): string {
  return (
    errorMessage
      // Everything after "Call log:" is Playwright narrating our own actions.
      .split(/^\s*call log:/im)[0]!
      .replace(/waiting for [^\n]*/gi, ' ')
      .replace(/(?:page|frame|locator)\.[a-zA-Z]+\([^)]*\)/g, ' ')
      .replace(/getBy[A-Za-z]+\([^)]*\)/g, ' ')
      .replace(/locator\([^)]*\)/g, ' ')
  );
}

// ─── Model enrichment (only when the prose gave up too little) ───────────────

export const reportEnrichmentSchema = z.object({
  title: z.string().max(MAX_TITLE).nullable(),
  steps: z.array(z.string().min(1).max(MAX_STEP_CHARS)).max(MAX_STEPS),
  expected: z.string().max(600).nullable(),
  actual: z.string().max(600).nullable(),
  /** Why the model read it this way — shown to the user, never acted on. */
  reading: z.string().max(600),
});
export type ReportEnrichment = z.infer<typeof reportEnrichmentSchema>;

const ENRICH_SYSTEM = `You are reading a bug report inside QAAI, an AI QA engineer.

A deterministic parser has already pulled out everything the reporter wrote in a
recognised convention. You are being asked ONLY because it found too little to
build a test from. Your job is to read the prose and state the reproduction
steps, the expected result and the actual result that the reporter described.

Rules:
- Report only what the text supports. If the text does not say what the user
  expected to happen, return null for expected. Inventing an expectation
  produces a test that passes against a broken application, which is worse than
  no test at all.
- Steps are imperative and concrete: "Open /cart", "Click Check out", "Enter a
  card number ending 4242". One action per step.
- Never write code. Someone else does that from your steps.`;

/**
 * Ask the model for the structure the prose did not give up.
 *
 * Deliberately narrow: it returns steps/expected/actual and nothing else. URLs,
 * selectors and error strings are never asked for, because those were extracted
 * verbatim from the text and a model paraphrasing a selector is a selector that
 * no longer matches anything.
 */
export async function enrichReport(
  llm: LlmService,
  ctx: CallContext,
  args: { text: string; extracted: ExtractedReport },
): Promise<ReportEnrichment> {
  const { text, extracted } = args;

  const prompt = `BUG REPORT AS PASTED
${text.slice(0, 20_000)}

WHAT THE PARSER ALREADY FOUND (do not contradict it)
  title:     ${extracted.title ?? '(none)'}
  steps:     ${extracted.steps.length > 0 ? extracted.steps.map((s, i) => `\n    ${i + 1}. ${s}`).join('') : '(none found)'}
  expected:  ${extracted.expected ?? '(none found)'}
  actual:    ${extracted.actual ?? '(none found)'}
  urls:      ${[...extracted.urls, ...extracted.paths].join(', ') || '(none)'}
  selectors: ${extracted.selectors.join(', ') || '(none)'}
  errors:    ${extracted.errorStrings.join(' | ') || '(none)'}

Fill in what is missing. Repeat what is already there unchanged.`;

  return llm.structured(ctx, {
    tier: 'cheap',
    effort: 'medium',
    system: ENRICH_SYSTEM,
    prompt,
    schema: reportEnrichmentSchema,
    schemaName: 'ReportEnrichment',
    maxTokens: 2000,
  });
}

/**
 * Fold a model's reading into the deterministic extraction, recording exactly
 * which fields it supplied.
 *
 * The model never overwrites the reporter. A field the parser found stays as the
 * parser found it, so nothing the model paraphrased can quietly replace what the
 * ticket actually says, and `enrichedFields` tells the UI which lines to caveat.
 */
export function mergeEnrichment(
  extracted: ExtractedReport,
  enrichment: ReportEnrichment | null,
): ExtractedReport {
  if (!enrichment) return extracted;

  const enrichedFields: string[] = [];
  const merged: ExtractedReport = { ...extracted };

  if (merged.steps.length === 0 && enrichment.steps.length > 0) {
    merged.steps = enrichment.steps.slice(0, MAX_STEPS).map(tidyStep).filter(Boolean);
    merged.stepsFormat = 'NONE';
    if (merged.steps.length > 0) enrichedFields.push('steps');
  }
  if (!merged.title && enrichment.title) {
    merged.title = enrichment.title.slice(0, MAX_TITLE);
    enrichedFields.push('title');
  }
  if (!merged.expected && enrichment.expected) {
    merged.expected = enrichment.expected;
    enrichedFields.push('expected');
  }
  if (!merged.actual && enrichment.actual) {
    merged.actual = enrichment.actual;
    enrichedFields.push('actual');
  }

  merged.enrichedFields = enrichedFields;
  return merged;
}

// ─── The orchestrator ────────────────────────────────────────────────────────

export interface ReproResult {
  /** Exactly what the parser read, before any model saw it. */
  extracted: ExtractedReport;
  /** The parser's reading plus anything the model filled in. */
  merged: ExtractedReport;
  match: FlowMatchResult;
  duplicates: DuplicateReport;
  item: PlanItem;
  notes: string[];
  /** Null when a duplicate stopped generation — see `duplicates.duplicateOf`. */
  test: GeneratedTest | null;
}

/**
 * Bug report in, proposed test out.
 *
 * Order matters and is the whole design: parse deterministically, match against
 * the crawl, check for a duplicate, and only then spend a model call. A
 * duplicate short-circuits before generation, because the cheapest way to answer
 * "write me a test for this" is sometimes "you already have one".
 */
export async function reproduceFromReport(
  llm: LlmService,
  ctx: CallContext,
  args: {
    text: string;
    flowMap: FlowMap | null;
    language: Language;
    framework: UiFramework;
    existingTests?: readonly CoveringTest[];
    availableSecretNames?: string[];
    source?: ReproSource;
    /** Generate even when an existing test already covers this. */
    force?: boolean;
    /** Id carried onto the plan item; the API passes its PlanItem row id. */
    planItemId?: string;
  },
): Promise<ReproResult> {
  const source: ReproSource = args.source ?? { kind: 'TEXT' };
  const extracted = extractBugReport(args.text);

  // The model is asked for structure only when the prose withheld it. A report
  // with numbered steps and an Expected section does not need a model to read
  // it, and paying for one would make the reading less reproducible, not more.
  let merged = extracted;
  if (extracted.structureScore < ENRICH_BELOW_SCORE) {
    try {
      merged = mergeEnrichment(extracted, await enrichReport(llm, ctx, { text: args.text, extracted }));
    } catch {
      // Enrichment is an optimisation. Losing it means a thinner plan item, not
      // a failed request — the deterministic reading still stands on its own.
      merged = extracted;
    }
  }

  const match = matchFlowMap(merged, args.flowMap);
  const duplicates = findCoveringTests(merged, match, args.existingTests ?? []);

  const { item, notes } = buildReproPlanItem({
    extracted: merged,
    match,
    source,
    id: args.planItemId ?? `repro-${Date.now()}`,
  });

  if (merged.enrichedFields.length > 0) {
    notes.unshift(
      `A model supplied these fields because the report did not state them in any recognised form: ${merged.enrichedFields.join(', ')}. Check them against the ticket.`,
    );
  }

  if (duplicates.duplicateOf && !args.force) {
    return { extracted, merged, match, duplicates, item, notes, test: null };
  }

  if (!args.flowMap) {
    // generateTest needs a flow map for its locator context. Without one there
    // is nothing to generate against, and inventing an empty map would hand the
    // model a page description it would then treat as fact.
    notes.push(
      'No flow map exists for this project, so no test was generated. Run the Explorer against this environment first.',
    );
    return { extracted, merged, match, duplicates, item, notes, test: null };
  }

  const test = await generateTest(llm, ctx, {
    item,
    flowMap: args.flowMap,
    language: args.language,
    framework: args.framework,
    availableSecretNames: args.availableSecretNames,
  });

  return { extracted, merged, match, duplicates, item, notes, test };
}
