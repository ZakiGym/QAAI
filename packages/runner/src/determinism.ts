/**
 * Build determinism controls: order randomisation with a recorded seed, clock
 * control, seeded randomness, and timezone/locale pinning.
 *
 * Why this file exists at all: nothing in QAAI shuffles test order today, so an
 * ORDER-DEPENDENT test — test B only passes because test A ran first and left
 * something behind — is invisible. It stays invisible for months, until CI
 * shards differently or someone renames a file, and then a suite that was green
 * forever goes red with no diff to blame. It is one of the top real causes of
 * what teams call "flake", and QAAI cannot currently see it.
 *
 * The whole feature is the SEED, not the shuffle. A shuffle you cannot replay
 * produces one red run and no information; "your suite fails in this order,
 * here is the seed" is a bug report. So every knob here is driven from a single
 * recorded seed, the seed is written into the run's artifacts, it is repeated in
 * the failure message, and `QAAI_DETERMINISM_SEED` re-runs the exact order with
 * no code change.
 *
 * Everything is OFF by default. Turning determinism on changes what a suite
 * exercises — a frozen clock is a different application than a running one —
 * and that is the run owner's call, never a default we make for them.
 *
 * Failure posture: this module NEVER corrupts a spec to satisfy a knob. If the
 * source cannot be parsed with confidence, the shuffle declines, the original
 * bytes are run, and the reason is recorded. Declining costs a feature; a
 * mangled spec would cost the run and read as a verdict on the application.
 */

import type { RunContext } from '@qaai/shared';

/** Set this to replay a recorded order. Highest precedence, deliberately. */
export const SEED_ENV = 'QAAI_DETERMINISM_SEED';

/** Golden-ratio constant; only used when no seed is available at all. */
const FALLBACK_SEED = 0x9e3779b9;

// ─── Seeded randomness ───────────────────────────────────────────────────────

/**
 * mulberry32. Chosen because it is ~10 lines, has no dependencies, and can be
 * serialised into a browser init script verbatim — the same generator has to run
 * in this process (to pick the order) and inside the page (to replace
 * Math.random), and those two must be the same algorithm or a "reproduced" run
 * reproduces nothing.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same generator as a source string, for injection into the page. */
const MULBERRY32_SOURCE = `function (seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}`;

/** Any number in, a usable uint32 out. Seeds arrive from env strings and hashes. */
export function normalizeSeed(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const u = Math.abs(Math.trunc(n)) >>> 0;
  return u === 0 ? FALLBACK_SEED : u;
}

/**
 * Fisher–Yates, descending, so the permutation for a given seed is fixed by the
 * algorithm and not by the caller's array — that is what makes a recorded seed
 * replayable across processes. Returns a new array; the input is not touched.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DeterminismOptions {
  /** Shuffle the spec's top-level test blocks. The order is recorded. */
  shuffleOrder?: boolean;
  /** Overrides the run's seed. `QAAI_DETERMINISM_SEED` overrides this. */
  seed?: number | null;
  /** ISO instant to pin the clock to. Falls back to the run's freezeClockAt. */
  freezeClockAt?: string | null;
  /**
   * Shift the clock instead of stopping it — time still advances, from a
   * different starting point. This is how you reach a month boundary or a token
   * expiry without stopping the timers the app needs to run.
   */
  clockOffsetMs?: number | null;
  /** Replace Math.random with the seeded generator, in the page and in Node. */
  seedRandom?: boolean;
  /** IANA zone, e.g. `Pacific/Auckland`. Pins the browser and the test process. */
  timezoneId?: string | null;
  /** BCP-47 tag, e.g. `de-DE`. Pins the browser context. */
  locale?: string | null;
}

export interface ResolvedDeterminism {
  seed: number;
  /** Where the seed came from — the answer to "why did the order change?". */
  seedSource: 'env' | 'option' | 'run';
  shuffleOrder: boolean;
  clockMode: 'off' | 'frozen' | 'offset';
  /** Epoch ms the page's clock starts at, when the clock is controlled. */
  clockAtMs: number | null;
  clockAtIso: string | null;
  clockOffsetMs: number | null;
  seedRandom: boolean;
  timezoneId: string | null;
  locale: string | null;
  /** True when any knob is on. False means "behave exactly as before". */
  enabled: boolean;
  /** Knobs that were asked for and could not be honoured, in plain words. */
  warnings: string[];
}

type RunDeterminism = Pick<RunContext['determinism'], 'freezeClockAt' | 'randomSeed'>;

/**
 * Folds the three sources of truth — the environment, the caller's options, and
 * the run's own determinism block — into one record.
 *
 * The env var wins on purpose. Reproducing a shuffled failure has to be possible
 * from outside the code that produced it: an engineer with a seed from a failure
 * message must be able to replay it without editing a plugin.
 */
export function resolveDeterminism(
  run: RunDeterminism,
  options: DeterminismOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDeterminism {
  const warnings: string[] = [];

  const rawEnvSeed = env[SEED_ENV];
  const envSeed = rawEnvSeed !== undefined && rawEnvSeed !== '' ? normalizeSeed(rawEnvSeed) : null;
  if (rawEnvSeed !== undefined && rawEnvSeed !== '' && envSeed === null) {
    warnings.push(`${SEED_ENV}="${rawEnvSeed}" is not a number, so the run's own seed was used.`);
  }
  const optionSeed = options?.seed != null ? normalizeSeed(options.seed) : null;

  const seed = envSeed ?? optionSeed ?? normalizeSeed(run.randomSeed) ?? FALLBACK_SEED;
  const seedSource: ResolvedDeterminism['seedSource'] =
    envSeed !== null ? 'env' : optionSeed !== null ? 'option' : 'run';

  // An explicit `null` from the caller means "not this run", so only an absent
  // option falls through to whatever the run was configured with.
  const rawClock = options?.freezeClockAt !== undefined ? options.freezeClockAt : run.freezeClockAt;
  let clockAtMs: number | null = null;
  if (rawClock != null && rawClock !== '') {
    const parsed = Date.parse(rawClock);
    if (Number.isNaN(parsed)) {
      warnings.push(`freezeClockAt="${rawClock}" is not a parsable date, so the clock ran free.`);
    } else {
      clockAtMs = parsed;
    }
  }

  const offset =
    options?.clockOffsetMs != null && Number.isFinite(options.clockOffsetMs)
      ? Math.trunc(options.clockOffsetMs)
      : null;
  if (options?.clockOffsetMs != null && offset === null) {
    warnings.push(`clockOffsetMs=${String(options.clockOffsetMs)} is not a finite number; ignored.`);
  }

  // Freezing and offsetting are mutually exclusive: one stops time at an
  // instant, the other starts it somewhere else and lets it run. Asked for both,
  // the freeze wins and the offset is reported, rather than silently composed
  // into a third behaviour nobody asked for.
  let clockMode: ResolvedDeterminism['clockMode'] = 'off';
  if (clockAtMs !== null) {
    clockMode = 'frozen';
    if (offset !== null && offset !== 0) {
      warnings.push('freezeClockAt and clockOffsetMs were both set; the freeze took precedence.');
    }
  } else if (offset !== null && offset !== 0) {
    clockMode = 'offset';
  }

  const timezoneId = options?.timezoneId?.trim() || null;
  const locale = options?.locale?.trim() || null;
  const shuffleOrder = options?.shuffleOrder === true;
  const seedRandom = options?.seedRandom === true;

  return {
    seed,
    seedSource,
    shuffleOrder,
    clockMode,
    clockAtMs: clockMode === 'frozen' ? clockAtMs : null,
    clockAtIso: clockMode === 'frozen' && clockAtMs !== null ? new Date(clockAtMs).toISOString() : null,
    clockOffsetMs: clockMode === 'offset' ? offset : null,
    seedRandom,
    timezoneId,
    locale,
    enabled: shuffleOrder || seedRandom || clockMode !== 'off' || timezoneId !== null || locale !== null,
    warnings,
  };
}

// ─── Source scanning ─────────────────────────────────────────────────────────
//
// Reordering test blocks means moving ranges of a TypeScript file, so the only
// thing that matters is finding their exact boundaries. A regex cannot: `test(`
// appears in strings, in comments, and inside other tests. So this is a small
// brace-matching scanner that understands the four things that hide a brace —
// comments, quoted strings, template literals with `${}`, and regex literals.
//
// It is deliberately conservative. Every path that is not certain returns -1,
// which becomes "declined to shuffle" upstream rather than a guess.

/** Identifiers after which a `/` starts a regex rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'void',
  'delete',
  'new',
  'throw',
]);

function identifierEndingAt(src: string, end: number): string {
  let i = end;
  while (i > 0 && /[A-Za-z0-9_$]/.test(src[i - 1]!)) i--;
  return src.slice(i, end);
}

/** End index (exclusive) of a '...' or "..." literal starting at i, or -1. */
function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    // A raw newline inside a normal string is a syntax error; bail rather than
    // run off the end of the file looking for a quote that is not coming.
    if (ch === '\n') return -1;
    j++;
  }
  return -1;
}

/** End index (exclusive) of a regex literal starting at i, or -1. */
function skipRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '\n') return -1;
    if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '/') {
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      return j;
    }
    j++;
  }
  return -1;
}

/**
 * Walks code from `start` until `closer` is found at this nesting level, and
 * returns its index. With `closer === null` it walks the whole file and returns
 * its length. Returns -1 on anything unterminated or unbalanced.
 *
 * `onTopLevel` is only invoked at the outermost level (`closer === null`) — that
 * is exactly the definition of "a top-level statement", which is the only place
 * a test block is allowed to be shuffled from.
 */
function scanCode(
  src: string,
  start: number,
  closer: string | null,
  onTopLevel?: (index: number) => number | null,
): number {
  let i = start;
  let prevSig = '';

  while (i < src.length) {
    const ch = src[i]!;

    if (closer !== null && ch === closer) return i;

    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return closer === null ? src.length : -1;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(src, i);
      if (end === -1) return -1;
      i = end;
      prevSig = 'x';
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(src, i);
      if (end === -1) return -1;
      i = end;
      prevSig = 'x';
      continue;
    }
    if (ch === '/' && regexAllowedAfter(src, i, prevSig)) {
      const end = skipRegex(src, i);
      if (end === -1) return -1;
      i = end;
      prevSig = 'x';
      continue;
    }

    if (closer === null && onTopLevel && !/\s/.test(ch)) {
      const jump = onTopLevel(i);
      if (jump !== null) {
        if (jump <= i) return -1;
        i = jump;
        prevSig = ';';
        continue;
      }
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      const close = ch === '(' ? ')' : ch === '[' ? ']' : '}';
      const end = scanCode(src, i + 1, close);
      if (end === -1) return -1;
      i = end + 1;
      prevSig = close;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') return -1;

    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }

  return closer === null ? src.length : -1;
}

function regexAllowedAfter(src: string, i: number, prevSig: string): boolean {
  if (prevSig === '') return true;
  if (!/[A-Za-z0-9_$)\]]/.test(prevSig)) return true;
  // `return /x/` is a regex, `count / 2` is division, and both end in a word
  // character — the identifier itself is the only way to tell them apart.
  const ident = identifierEndingAt(src, lastSigIndex(src, i) + 1);
  return REGEX_PRECEDING_KEYWORDS.has(ident);
}

function lastSigIndex(src: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  return j;
}

/** End index (exclusive) of a template literal starting at i, or -1. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '`') return j + 1;
    if (ch === '$' && src[j + 1] === '{') {
      const end = scanCode(src, j + 2, '}');
      if (end === -1) return -1;
      j = end + 1;
      continue;
    }
    j++;
  }
  return -1;
}

// ─── Finding test blocks ─────────────────────────────────────────────────────

/**
 * Call chains that own a test and may therefore be moved. `test.describe` moves
 * as one unit, which is correct: a describe is a suite, and shuffling inside it
 * separately would be a second, different feature.
 */
const MOVABLE_CHAIN_PARTS = new Set([
  'describe',
  'only',
  'skip',
  'fixme',
  'fail',
  'slow',
  'serial',
  'parallel',
]);

export interface TestBlock {
  /** The call as written, e.g. `test` or `test.describe.serial`. */
  callee: string;
  /** The first argument when it is a plain string literal, else a placeholder. */
  title: string;
  /** Start of the block including any doc comment directly above it. */
  start: number;
  /** End of the block, past its trailing semicolon. */
  end: number;
}

export interface ScanResult {
  blocks: TestBlock[];
  /** False when the file did not parse cleanly — nothing may be moved. */
  ok: boolean;
}

const CALL_START = /test((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/y;

/**
 * Every top-level `test(...)` / `test.describe(...)` in the file, with the exact
 * byte range each occupies.
 *
 * Hooks (`beforeEach`, `afterAll`, `test.use`, `test.describe.configure`) are
 * NOT collected. They are not tests, and their position relative to the tests
 * carries meaning a shuffle has no business rearranging.
 */
export function findTestBlocks(source: string): ScanResult {
  const blocks: TestBlock[] = [];

  const onTopLevel = (index: number): number | null => {
    if (source[index] !== 't') return null;
    // `mytest(` and `helper.test(` are not the global `test`.
    const before = index > 0 ? source[index - 1]! : '';
    if (/[A-Za-z0-9_$.]/.test(before)) return null;

    CALL_START.lastIndex = index;
    const m = CALL_START.exec(source);
    if (!m) return null;

    const chain = m[1]!
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!chain.every((part) => MOVABLE_CHAIN_PARTS.has(part))) return null;

    const openParen = index + m[0].length - 1;
    const closeParen = scanCode(source, openParen + 1, ')');
    if (closeParen === -1) return null;

    let end = closeParen + 1;
    // Take the statement's own semicolon with it, and any trailing spaces on
    // that line, so a moved block does not leave a stray `;` behind.
    while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++;
    if (source[end] === ';') end++;

    const floor = blocks.length > 0 ? blocks[blocks.length - 1]!.end : 0;
    blocks.push({
      callee: `test${m[1]!.replace(/\s+/g, '')}`,
      title: readTitle(source, openParen + 1) ?? `#${blocks.length + 1}`,
      start: expandStart(source, index, floor),
      end,
    });
    return end;
  };

  const ok = scanCode(source, 0, null, onTopLevel) === source.length;
  return { blocks: ok ? blocks : [], ok };
}

/** The first argument, when it is a plain string literal we can read verbatim. */
function readTitle(source: string, from: number): string | null {
  let i = from;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  const ch = source[i];
  if (ch !== '"' && ch !== "'" && ch !== '`') return null;
  const end = ch === '`' ? skipTemplate(source, i) : skipQuoted(source, i);
  if (end === -1) return null;
  const raw = source.slice(i + 1, end - 1);
  // A template with a substitution has no fixed title; say so rather than
  // recording `Order ${id}` as if it were the name that ran.
  if (ch === '`' && raw.includes('${')) return null;
  return raw;
}

/**
 * Pulls a block's start back over the doc comment written directly above it.
 *
 * Without this, shuffling detaches every comment from the test it explains and
 * silently re-attaches it to whichever test lands in that slot — which is worse
 * than not shuffling, because the file now lies.
 */
function expandStart(source: string, start: number, floor: number): number {
  let lineStart = source.lastIndexOf('\n', start - 1) + 1;
  if (source.slice(lineStart, start).trim() !== '') return start;

  let cursor = lineStart;
  while (cursor > floor) {
    const prevEnd = cursor - 1;
    const prevStart = source.lastIndexOf('\n', prevEnd - 1) + 1;
    if (prevStart < floor) break;
    const text = source.slice(prevStart, prevEnd).trim();
    if (text === '') break;
    if (!(text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.endsWith('*/')))
      break;
    cursor = prevStart;
    lineStart = prevStart;
  }
  return lineStart;
}

// ─── Reordering ──────────────────────────────────────────────────────────────

export interface ShuffleResult {
  code: string;
  /** True when the blocks were reordered by the seed. */
  applied: boolean;
  /** True when the emitted source actually differs from the input. */
  changed: boolean;
  /** Declared block titles, in declaration order. */
  declaredOrder: string[];
  /** Declared indices (0-based) in the order they will now execute. */
  executionOrder: number[];
  /** Present when the shuffle declined. Always says why, never silent. */
  reason: string | null;
}

/**
 * Reorders the file's top-level test blocks under the seed.
 *
 * The blocks swap places; everything between them — imports, helpers, hooks,
 * module-level state — stays exactly where it was. That is what makes this a
 * reordering of the SUITE and not a rewrite of the file, and it is what lets a
 * shuffled spec still compile.
 */
export function shuffleSpecOrder(source: string, seed: number): ShuffleResult {
  const declined = (reason: string): ShuffleResult => ({
    code: source,
    applied: false,
    changed: false,
    declaredOrder: [],
    executionOrder: [],
    reason,
  });

  const { blocks, ok } = findTestBlocks(source);
  if (!ok) {
    return declined(
      'QAAI could not parse this spec confidently enough to move code inside it, so it ran in declaration order.',
    );
  }
  if (blocks.length < 2) {
    return declined(
      `Order randomisation needs at least two top-level test blocks; this spec has ${blocks.length}.`,
    );
  }

  const indices = seededShuffle(
    blocks.map((_, i) => i),
    seed,
  );

  let code = '';
  let cursor = 0;
  for (let slot = 0; slot < blocks.length; slot++) {
    const target = blocks[slot]!;
    const source_ = blocks[indices[slot]!]!;
    code += source.slice(cursor, target.start) + source.slice(source_.start, source_.end);
    cursor = target.end;
  }
  code += source.slice(cursor);

  return {
    code,
    applied: true,
    changed: code !== source,
    declaredOrder: blocks.map((b) => b.title),
    executionOrder: indices,
    reason: null,
  };
}

// ─── In-page determinism ─────────────────────────────────────────────────────

/**
 * The script that runs before any of the page's own code, on every document.
 *
 * `includeClock` is false when Playwright's own clock API is driving time: both
 * mechanisms install at document start, and running them together would leave
 * two different fake `Date`s fighting over the same page.
 */
export function buildInitScript(
  d: ResolvedDeterminism,
  opts: { includeClock: boolean } = { includeClock: true },
): string {
  const parts: string[] = [];

  if (d.seedRandom) {
    parts.push(`  var __mk = ${MULBERRY32_SOURCE};
  Math.random = __mk(${d.seed});`);
  }

  if (opts.includeClock && d.clockMode !== 'off') {
    const expr =
      d.clockMode === 'frozen'
        ? `${d.clockAtMs}`
        : `__realNow.call(__RealDate) + (${d.clockOffsetMs})`;
    // A frozen clock must freeze the monotonic clock too, or a page that
    // measures elapsed time sees Date standing still while performance.now
    // races ahead — a contradiction no real browser ever presents.
    const perf =
      d.clockMode === 'frozen'
        ? `  performance.now = function () { return 0; };`
        : `  var __perfStart = __realPerf.call(performance);
  performance.now = function () { return __realPerf.call(performance) - __perfStart; };`;
    parts.push(`  var __RealDate = globalThis.Date;
  var __realNow = __RealDate.now;
  var __realPerf = performance.now;
  var __now = function () { return ${expr}; };
  function FakeDate(a, b, c, e, f, g, h) {
    if (!(this instanceof FakeDate)) return new __RealDate(__now()).toString();
    switch (arguments.length) {
      case 0: return new __RealDate(__now());
      case 1: return new __RealDate(a);
      default: return new __RealDate(a, b, c === undefined ? 1 : c, e || 0, f || 0, g || 0, h || 0);
    }
  }
  FakeDate.prototype = __RealDate.prototype;
  FakeDate.now = function () { return __now(); };
  FakeDate.parse = __RealDate.parse;
  FakeDate.UTC = __RealDate.UTC;
  globalThis.Date = FakeDate;
${perf}`);
  }

  if (parts.length === 0) return '';
  return `(function () {\n${parts.join('\n')}\n})();\n`;
}

/**
 * The block prepended to the spec so determinism is in force before the first
 * test runs.
 *
 * It is injected into the source rather than configured in `playwright.config`
 * because Playwright's config cannot add fixtures or init scripts — `use` only
 * carries context options. Injection also keeps the exported repo honest: the
 * customer can read exactly what QAAI did to their suite.
 *
 * `browser` gates the half that needs a BrowserContext. An API or CLI spec never
 * requests one, and a `beforeEach` that asked for `context` there would launch a
 * browser the test does not use and time out waiting for it.
 */
export function renderDeterminismHeader(d: ResolvedDeterminism, opts: { browser: boolean }): string {
  const lines: string[] = [];
  const wantsPage = d.seedRandom || d.clockMode !== 'off';

  if (!d.seedRandom && !(opts.browser && wantsPage)) return '';

  const injectBrowser = opts.browser && wantsPage;

  if (injectBrowser) lines.push(`import { test as __qaaiTest } from '@playwright/test';`);

  lines.push(
    '// ─── QAAI determinism kit ───────────────────────────────────────────────',
    `// seed ${d.seed} · order ${d.shuffleOrder ? 'shuffled' : 'as declared'} · clock ${d.clockMode}`,
    `// Replay this exact run with ${SEED_ENV}=${d.seed}.`,
  );

  if (d.seedRandom) {
    // The test process shuffles fixture data too; patching only the page would
    // make half the randomness reproducible and leave the other half free.
    lines.push(`const __qaaiRng = ${MULBERRY32_SOURCE};`, `Math.random = __qaaiRng(${d.seed});`);
  }

  if (injectBrowser) {
    const full = JSON.stringify(buildInitScript(d, { includeClock: true }));
    const randomOnly = JSON.stringify(buildInitScript(d, { includeClock: false }));
    const clockOn = d.clockMode !== 'off';
    lines.push(
      `__qaaiTest.beforeEach(async ({ context }) => {`,
      `  const clock = (context as unknown as { clock?: Record<string, (arg?: unknown) => Promise<void>> }).clock;`,
      `  // Playwright's own clock API is the right tool where it exists; the`,
      `  // patched Date is the fallback for older installs — never both at once,`,
      `  // or two fake Dates end up fighting over the same document.`,
      `  const native = ${clockOn ? 'typeof clock?.install === "function"' : 'false'};`,
      `  const script = native ? ${randomOnly} : ${full};`,
      `  if (script) await context.addInitScript({ content: script });`,
    );
    if (clockOn) {
      lines.push(`  if (native && clock) {`);
      if (d.clockMode === 'frozen') {
        lines.push(
          `    await clock.install({ time: new Date(${d.clockAtMs}) });`,
          `    await clock.pauseAt(new Date(${d.clockAtMs}));`,
        );
      } else {
        lines.push(`    await clock.install({ time: new Date(Date.now() + (${d.clockOffsetMs})) });`);
      }
      lines.push(`  }`);
    }
    lines.push(`});`);
  }

  return `${lines.join('\n')}\n\n`;
}

/**
 * Whether the spec asks for a browser, decided from its fixture destructuring.
 *
 * Cheap and source-level on purpose: the alternative is launching a browser to
 * find out, which is exactly the cost this avoids for the API, CLI and database
 * specs that share this harness.
 */
export function usesBrowserFixtures(source: string): boolean {
  const BROWSER_FIXTURES = new Set(['page', 'context', 'browser', 'browserName']);
  for (const m of source.matchAll(/\(\s*\{([^}]*)\}/g)) {
    for (const name of m[1]!.split(',')) {
      const ident = name.split(':')[0]!.trim();
      if (BROWSER_FIXTURES.has(ident)) return true;
    }
  }
  return false;
}

// ─── The one call the harness makes ──────────────────────────────────────────

export interface DeterminismPlan {
  determinism: ResolvedDeterminism;
  /** The spec source to actually write, after reordering and injection. */
  code: string;
  shuffle: ShuffleResult | null;
  /** Everything worth telling the reader, including declined knobs. */
  notes: string[];
}

/** Never mangles a spec: any doubt anywhere leaves `code` byte-identical. */
export function planDeterminism(source: string, d: ResolvedDeterminism): DeterminismPlan {
  const notes = [...d.warnings];

  if (!d.enabled) {
    return { determinism: d, code: source, shuffle: null, notes };
  }

  let shuffle: ShuffleResult | null = null;
  let code = source;

  if (d.shuffleOrder) {
    shuffle = shuffleSpecOrder(source, d.seed);
    if (shuffle.applied) code = shuffle.code;
    else if (shuffle.reason) notes.push(shuffle.reason);
  }

  // Only a Playwright spec can carry the header — it is written in terms of
  // `test` from '@playwright/test'. Anything else keeps the seeded order and
  // skips the injection rather than acquiring an import it cannot resolve.
  const isPlaywrightSpec = /from\s+['"]@playwright\/test['"]/.test(source);
  if (isPlaywrightSpec) {
    code = renderDeterminismHeader(d, { browser: usesBrowserFixtures(source) }) + code;
  } else if (d.seedRandom || d.clockMode !== 'off') {
    notes.push(
      'Clock and random-number control were skipped: this test is not a Playwright spec, so there is no page to install them in.',
    );
  }

  return { determinism: d, code, shuffle, notes };
}

/**
 * The line that turns a red run into a bug report. Appended to the failure
 * message, because that is the one place the reader is already looking.
 */
export function reproduceHint(plan: DeterminismPlan): string | null {
  const d = plan.determinism;
  if (!d.enabled) return null;

  const bits: string[] = [`seed ${d.seed}`];
  if (plan.shuffle?.applied) {
    const order = plan.shuffle.executionOrder
      .map((i) => plan.shuffle!.declaredOrder[i] ?? `#${i + 1}`)
      .join(' → ');
    bits.push(`order: ${order}`);
  }
  if (d.clockMode === 'frozen') bits.push(`clock frozen at ${d.clockAtIso}`);
  if (d.clockMode === 'offset') bits.push(`clock offset by ${d.clockOffsetMs}ms`);
  if (d.seedRandom) bits.push('Math.random seeded');
  if (d.timezoneId) bits.push(`TZ ${d.timezoneId}`);
  if (d.locale) bits.push(`locale ${d.locale}`);

  return `Determinism: ${bits.join(' · ')}. Reproduce with ${SEED_ENV}=${d.seed}.`;
}

/** The record written into the run's artifacts, so a seed outlives the log. */
export function determinismRecord(plan: DeterminismPlan): Record<string, unknown> {
  return {
    seed: plan.determinism.seed,
    seedSource: plan.determinism.seedSource,
    reproduceWith: `${SEED_ENV}=${plan.determinism.seed}`,
    shuffleOrder: plan.determinism.shuffleOrder,
    orderApplied: plan.shuffle?.applied ?? false,
    declaredOrder: plan.shuffle?.declaredOrder ?? [],
    executionOrder: plan.shuffle?.executionOrder ?? [],
    executionOrderTitles:
      plan.shuffle?.executionOrder.map((i) => plan.shuffle!.declaredOrder[i] ?? `#${i + 1}`) ?? [],
    clockMode: plan.determinism.clockMode,
    clockAt: plan.determinism.clockAtIso,
    clockOffsetMs: plan.determinism.clockOffsetMs,
    seedRandom: plan.determinism.seedRandom,
    timezoneId: plan.determinism.timezoneId,
    locale: plan.determinism.locale,
    notes: plan.notes,
  };
}
