/**
 * Performance budgets — Core Web Vitals in a real browser (§4 PERFORMANCE).
 *
 * QAAI already had LOAD, which asks how many requests per second the server
 * survives. Nothing here asked what the person holding the laptop waits for, so
 * a page that serves in 20ms and paints in four seconds passed every test in
 * this product. This plugin closes that gap: it opens the page in Chromium,
 * measures LCP, CLS, INP, TBT, FCP and TTFB, adds up the bytes by resource type,
 * and checks both against budgets the spec declares.
 *
 * ── ONE MEASUREMENT IS NOISE ────────────────────────────────────────────────
 *
 * This has to be said in the file, because it is the difference between a perf
 * test people keep and one they delete.
 *
 * A cold cache, a busy CI box, a slow DNS lookup or a neighbouring container
 * moves LCP by seconds. A single load cannot tell any of that apart from a real
 * regression. A performance test that fails randomly gets muted within a week
 * and deleted within a month, and then the product has *worse* coverage than
 * before it existed, because everyone believes the page is being watched.
 *
 * So this plugin never gates on one number:
 *
 *  - It runs `iterations` loads (default 5) and gates on the **median**, which a
 *    single slow outlier cannot move.
 *  - It reports the **spread** — n, min, max, and (max−min)/median — on every
 *    metric, budgeted or not, so a number that is really a range is never
 *    presented as a fact.
 *  - When the iterations **disagreed about the verdict** — some loads under the
 *    budget, some over — the step says so in plain words. That is the honest
 *    version of "it passed": the same commit measured again could go the other
 *    way, and the step tells you that instead of pretending otherwise.
 *  - And it does not cry wolf. A range of 1ms to 5ms is a 400% relative spread
 *    that describes nothing; a warning there is a warning people learn to skip
 *    past, which costs us the one that matters. See `NOISE_FLOOR`.
 *
 * The verdict still comes from the median in that case, and does not flip. This
 * is a deliberate call, not an oversight. Failing on any breached iteration is
 * exactly the random failure that kills perf tests; hiding a disagreement is
 * exactly the false confidence that makes them useless. Reporting the median as
 * the verdict *and* the disagreement as a loud caveat plus a finding is the only
 * combination that is both stable and honest. If you want the strict behaviour,
 * lower the budget until the median crosses it — that is a number you can argue
 * about, unlike "the worst of five loads".
 *
 * ── Lighthouse is preferred, and optional ───────────────────────────────────
 *
 * If Lighthouse is installed, QAAI runs it and reads its JSON: it is the number
 * everyone else quotes, its audits are maintained by people who do this full
 * time, and reimplementing them would be building a worse copy. If it is not
 * installed, the built-in collector below measures the same metrics from
 * PerformanceObserver, injected before the page loads. A missing Lighthouse is a
 * NOTE in the results, never a failure and never a skip — there is a working
 * measurement either way, and reporting a config gap as a failing test blames
 * the customer's application for our worker's setup. This repo has fixed that
 * same mistake four times.
 *
 * Both paths are pinned to the SAME throttling profile. Lighthouse's default lab
 * config simulates a mid-tier phone on slow 4G; left alone, the identical page
 * would clear a budget on one path and blow it on the other, and the budget
 * would mean nothing. See `lighthouseArgs`.
 *
 * ── Deliberate omissions ────────────────────────────────────────────────────
 *
 * `ctx.grid` is ignored. Driving a browser in someone else's data centre
 * measures the round trip to that data centre, not what a user experiences, and
 * a perf number collected that way is worse than none.
 */

import { spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERFORMANCE_METRICS,
  SECRET_MASK,
  PERFORMANCE_METRIC_LABELS,
  PERFORMANCE_METRIC_UNITS,
  PERFORMANCE_RESOURCE_LABELS,
  PERFORMANCE_RESOURCE_TYPES,
  maskSecrets,
  maskUrl,
  performanceTestSpecSchema,
} from '@qaai/shared';
import type {
  ExecutableTest,
  Finding,
  PerformanceMetric,
  PerformanceNetworkPreset,
  PerformanceResourceType,
  PerformanceTestSpec,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';
import type { BrowserContext, Page } from 'playwright';
import { acquireBrowser } from '../browser-pool.js';

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One metric reading. `null` means the browser never reported it. */
type MetricValues = Partial<Record<PerformanceMetric, number>>;

/** Bytes over the wire, by class, for one load. */
type ByteTotals = Record<PerformanceResourceType, number>;

interface Offender {
  url: string;
  type: PerformanceResourceType;
  bytes: number;
}

/** Everything one load produced. */
interface Iteration {
  metrics: MetricValues;
  bytes: ByteTotals;
  offenders: Offender[];
  /** Resources whose size the browser refused to disclose (no Timing-Allow-Origin). */
  opaqueResources: number;
  /**
   * True when INP is an upper bound rather than a reading: somebody interacted,
   * but no event lasted long enough for the browser to hand us a duration.
   */
  inpUpperBound: boolean;
  notes: string[];
}

/** The raw shape the in-page reader returns. Mirrors READ_SCRIPT exactly. */
interface RawPageData {
  /**
   * Identifies the DOCUMENT these numbers came from. A fresh document gets a
   * fresh nonce, which is how the collector notices it is describing a page
   * nobody asked about. See `collectWithBrowser`.
   */
  nonce: string | null;
  lcp: number | null;
  fcp: number | null;
  cls: number | null;
  ttfb: number | null;
  longTasks: Array<{ start: number; duration: number }>;
  interactionDurations: number[];
  /** How many interactions the browser counted, including ones too fast to time. */
  interactionCount: number;
  documentBytes: number;
  resources: Array<{
    url: string;
    initiatorType: string;
    transferSize: number;
    encodedBodySize: number;
  }>;
  observerErrors: string[];
}

// ─── The page-side collector ─────────────────────────────────────────────────

/*
 * Both scripts below are strings on purpose. They run in the PAGE, not in Node,
 * and this package's tsconfig has no "dom" lib — `PerformanceObserver`,
 * `performance` and the entry types do not exist as far as TypeScript here is
 * concerned. visual.ts hand-types `document` for the same reason; a string keeps
 * the boundary obvious rather than smuggling browser globals into Node's scope
 * with a `declare`.
 *
 * The collector is installed with `page.addInitScript`, so it is running before
 * the document's first byte arrives. Anything less misses FCP and the layout
 * shifts that happen during load, which are most of them.
 */
const COLLECT_SCRIPT = `(() => {
  const state = {
    // addInitScript runs once per DOCUMENT, so this nonce changes the moment the
    // page navigates — which is the only reliable way to notice that the numbers
    // we are about to read describe a different page from the one we measured.
    nonce: String(Date.now()) + ':' + String(Math.random()),
    lcp: null,
    fcp: null,
    cls: 0,
    longTasks: [],
    interactions: [],
    observerErrors: [],
  };
  // Non-writable so a page script cannot clobber the measurement by accident.
  Object.defineProperty(globalThis, '__qaaiPerf', { value: state, configurable: true });

  const observe = (type, handler, extra) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handler(entry);
      });
      observer.observe(Object.assign({ type: type, buffered: true }, extra || {}));
    } catch (err) {
      // An unsupported entry type is a gap in what we can report, never a
      // reason to break the page or lose the metrics that DID work.
      state.observerErrors.push(type + ': ' + ((err && err.message) || String(err)));
    }
  };

  // LCP fires repeatedly as bigger elements paint; the LAST one is the metric.
  observe('largest-contentful-paint', (e) => { state.lcp = e.startTime; });
  observe('paint', (e) => {
    if (e.name === 'first-contentful-paint' && state.fcp === null) state.fcp = e.startTime;
  });
  observe('longtask', (e) => { state.longTasks.push({ start: e.startTime, duration: e.duration }); });
  // Only entries with an interactionId are real user interactions; everything
  // else is an event handler that no human was waiting on.
  observe('event', (e) => {
    if (e.interactionId) state.interactions.push({ duration: e.duration, start: e.startTime });
  }, { durationThreshold: 16 });

  // CLS is not the sum of every shift — it is the largest SESSION WINDOW: shifts
  // no more than 1s apart, spanning at most 5s. Summing everything instead
  // inflates the score on any long-lived page and is the single most common way
  // a home-grown CLS number disagrees with Lighthouse.
  let value = 0;
  let first = 0;
  let last = 0;
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    if (value !== 0 && (e.startTime - last > 1000 || e.startTime - first > 5000)) value = 0;
    if (value === 0) first = e.startTime;
    value += e.value;
    last = e.startTime;
    if (value > state.cls) state.cls = value;
  });
})();`;

/** Just the document nonce, read right after the navigation settles. */
const NONCE_SCRIPT = `(globalThis.__qaaiPerf ? globalThis.__qaaiPerf.nonce : null)`;

const READ_SCRIPT = `(() => {
  const perf = globalThis.performance;
  const state = globalThis.__qaaiPerf || {
    nonce: null, lcp: null, fcp: null, cls: null, longTasks: [], interactions: [],
    observerErrors: ['the collector never ran'],
  };
  const entries = (type) => (perf && perf.getEntriesByType ? perf.getEntriesByType(type) : []);
  const nav = entries('navigation')[0] || null;
  return {
    nonce: state.nonce,
    lcp: state.lcp,
    fcp: state.fcp,
    cls: state.cls,
    // TTFB is measured from the navigation start, which is what responseStart
    // already is on a navigation entry.
    ttfb: nav && nav.responseStart > 0 ? nav.responseStart : null,
    longTasks: state.longTasks,
    interactionDurations: state.interactions.map((i) => i.duration),
    // Counts every interaction, including the ones that finished too fast for
    // the observer's threshold — which is how we tell "nobody clicked" apart
    // from "everything was instant".
    interactionCount: (perf && Number(perf.interactionCount)) || 0,
    documentBytes: nav ? (Number(nav.transferSize) || Number(nav.encodedBodySize) || 0) : 0,
    resources: entries('resource').map((r) => ({
      url: String(r.name || ''),
      initiatorType: String(r.initiatorType || ''),
      transferSize: Number(r.transferSize) || 0,
      encodedBodySize: Number(r.encodedBodySize) || 0,
    })),
    observerErrors: state.observerErrors,
  };
})()`;

// ─── Pure helpers (exported for the unit suite) ──────────────────────────────

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Spread {
  n: number;
  median: number;
  min: number;
  max: number;
  /** (max − min) ÷ median. Infinity when the median is zero and the range is not. */
  relativeSpread: number;
}

export function summarise(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const mid = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A zero median with a non-zero range is not "0% spread", it is unbounded —
  // and it must read as noisy rather than as perfectly stable.
  const relativeSpread = mid > 0 ? (max - min) / mid : max > min ? Number.POSITIVE_INFINITY : 0;
  return { n: values.length, median: mid, min, max, relativeSpread };
}

export type Unit = 'ms' | 'score' | 'kb';

/**
 * Below this absolute range, a "wide spread" warning is a lie told with correct
 * arithmetic.
 *
 * The first live run of this plugin against the demo store reported "TTFB spread
 * 277%" on a range of 1ms to 5ms. That is true, useless, and precisely the kind
 * of warning that teaches people to stop reading the warnings — so relative
 * spread now only counts once the numbers are far enough apart for a human to
 * care. A metric can still be flagged as UNTRUSTWORTHY at any magnitude,
 * because that flag is about the verdict flipping, not about the size of the
 * wobble.
 */
export const NOISE_FLOOR: Record<Unit, number> = { ms: 50, score: 0.01, kb: 5 };

/**
 * The shortest event the platform will report a duration for. Not tunable: 16ms
 * is the floor `PerformanceObserver` accepts for `durationThreshold`.
 */
export const INP_OBSERVATION_FLOOR_MS = 16;

export function formatValue(value: number, unit: Unit): string {
  if (unit === 'ms') return `${Math.round(value)}ms`;
  // Rounding 0.4 KB to "0 KB" makes a working byte budget look broken.
  if (unit === 'kb') return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} KB`;
  // CLS is a small unitless number; three decimals is the resolution people
  // actually discuss it in, and trailing zeros just add noise.
  return String(Number(value.toFixed(3)));
}

export interface BudgetVerdict {
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  title: string;
  /** Set when FAILED — the step's error message. */
  message: string | null;
  /** The iterations disagreed about whether the budget was met. */
  untrustworthy: boolean;
  /** The spread is wider than the spec's tolerance. */
  noisy: boolean;
  breaches: number;
  stats: Spread | null;
}

/**
 * The whole gate, in one testable function.
 *
 * Reading order of the title: the verdict, then the evidence, then every reason
 * to doubt it. A reader who stops after the first clause is not misled; a reader
 * who continues learns exactly how solid the number is.
 */
export function evaluateBudget(opts: {
  label: string;
  unit: Unit;
  samples: readonly number[];
  budget: number;
  spreadTolerance: number;
  /** Why there is nothing to evaluate, used when `samples` is empty. */
  unmeasuredReason: string;
  /** An extra caveat about how the number was obtained, appended to the title. */
  note?: string;
}): BudgetVerdict {
  const stats = summarise(opts.samples);

  // Never invent a pass. A budget we could not evaluate is reported as not
  // evaluated, with the reason and what to do about it — the same call
  // external.ts makes for a report it could not find.
  if (!stats) {
    return {
      status: 'SKIPPED',
      title: `${opts.label} — not measured (budget ${formatValue(opts.budget, opts.unit)})`,
      message: opts.unmeasuredReason,
      untrustworthy: false,
      noisy: false,
      breaches: 0,
      stats: null,
    };
  }

  const breaches = opts.samples.filter((v) => v > opts.budget).length;
  const over = stats.median > opts.budget;
  // Disagreement is not the same thing as a wide spread: a metric can swing
  // wildly and still be nowhere near the budget, which is not a problem with
  // the verdict. What matters is whether the budget falls INSIDE the measured
  // range, because that is when a re-run could legitimately go the other way.
  const untrustworthy = breaches > 0 && breaches < stats.n;
  // A percentage is only information once the two ends are far enough apart to
  // mean something. 1ms to 4ms is a 300% spread and describes nothing.
  const meaningfulRange = stats.max - stats.min > NOISE_FLOOR[opts.unit];
  // `!(x <= t)` rather than `x > t`, so Infinity and NaN both read as noisy.
  const noisy = !(stats.relativeSpread <= opts.spreadTolerance) && meaningfulRange;

  const range =
    stats.n === 1
      ? '1 load'
      : `${stats.n} loads, ${formatValue(stats.min, opts.unit)}–${formatValue(stats.max, opts.unit)}` +
        (meaningfulRange && Number.isFinite(stats.relativeSpread)
          ? `, spread ${Math.round(stats.relativeSpread * 100)}%`
          : '');

  const caveats: string[] = [];
  if (opts.note) caveats.push(opts.note);
  if (stats.n === 1) {
    caveats.push(
      'measured once, so this is a sample and not a verdict — raise `iterations` to at least 5',
    );
  }
  if (untrustworthy) {
    // `breaches` counts the loads that went OVER. On a failure the interesting
    // number is the other side of that — the loads that met the budget — so the
    // count has to be flipped with the verb. Getting this wrong made the step
    // title contradict its own error message ("3 of 5 loads met the budget"
    // beside "2 of 5 loads were inside the budget") on the same result.
    const dissenting = over ? stats.n - breaches : breaches;
    caveats.push(
      `${dissenting} of ${stats.n} loads ${over ? 'met' : 'exceeded'} the budget, so this verdict is not trustworthy — the same commit could measure the other way`,
    );
  } else if (noisy && stats.n > 1) {
    caveats.push('the spread is wide enough that the median is a range, not a fact');
  }

  const headline =
    `${opts.label}: ${formatValue(stats.median, opts.unit)} median ` +
    `(budget ${formatValue(opts.budget, opts.unit)}) · ${range}`;

  return {
    status: over ? 'FAILED' : 'PASSED',
    title: caveats.length > 0 ? `${headline} · ${caveats.join('; ')}` : headline,
    message: over
      ? `${opts.label} was ${formatValue(stats.median, opts.unit)} at the median of ${stats.n} load(s), ` +
        `over the ${formatValue(opts.budget, opts.unit)} budget. ` +
        `Range ${formatValue(stats.min, opts.unit)}–${formatValue(stats.max, opts.unit)}.` +
        (untrustworthy
          ? ` ${stats.n - breaches} of ${stats.n} loads were inside the budget, so treat this as a signal to investigate rather than a settled regression.`
          : '')
      : null,
    untrustworthy,
    noisy,
    breaches,
    stats,
  };
}

const EXTENSION_TYPES: Array<[RegExp, PerformanceResourceType]> = [
  [/\.(m?js|cjs|jsx|tsx?)$/i, 'js'],
  [/\.css$/i, 'css'],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i, 'image'],
  [/\.(woff2?|ttf|otf|eot)$/i, 'font'],
  [/\.(mp4|webm|mov|mp3|wav|ogg|m4a)$/i, 'media'],
  [/\.(html?|xhtml)$/i, 'document'],
];

const INITIATOR_TYPES: Record<string, PerformanceResourceType> = {
  script: 'js',
  // A <link> with no usable extension is overwhelmingly a stylesheet; icons and
  // preloaded fonts carry extensions and are caught above.
  link: 'css',
  img: 'image',
  image: 'image',
  font: 'font',
  video: 'media',
  audio: 'media',
};

/**
 * What class of bytes is this?
 *
 * Extension first, initiator second. `initiatorType` describes who ASKED for the
 * resource, not what it is: a webfont pulled in by an @font-face rule reports
 * `css`, and counting it as CSS would quietly hide the biggest font payload on
 * the page inside the smallest budget on it.
 */
export function classifyResource(url: string, initiatorType: string): PerformanceResourceType {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Relative, data: or blob: — fall through to the raw string, then to the
    // initiator. Never throw: one odd URL must not lose a whole measurement.
    path = url.split(/[?#]/)[0] ?? url;
  }
  for (const [pattern, type] of EXTENSION_TYPES) {
    if (pattern.test(path)) return type;
  }
  return INITIATOR_TYPES[initiatorType.toLowerCase()] ?? 'other';
}

function emptyBytes(): ByteTotals {
  return {
    js: 0,
    css: 0,
    image: 0,
    font: 0,
    media: 0,
    document: 0,
    other: 0,
    total: 0,
  };
}

/**
 * A Chromium message that means "the browser is not installed", rather than
 * anything about the site under test. Same rule as k6 and appium: a missing tool
 * is SKIPPED with an install command, never FAILED.
 */
export function isMissingBrowserError(message: string): boolean {
  return /executable doesn'?t exist|please run the following command|playwright install|browsertype\.launch/i.test(
    message,
  );
}

// ─── Throttling ──────────────────────────────────────────────────────────────

export interface NetworkProfile {
  downKbps: number;
  upKbps: number;
  latencyMs: number;
}

/**
 * Chrome DevTools' own numbers, so a budget written against "fast-3g" here means
 * the same thing it means in the Network panel.
 */
export const NETWORK_PRESETS: Record<PerformanceNetworkPreset, NetworkProfile | null> = {
  none: null,
  'slow-3g': { downKbps: 400, upKbps: 400, latencyMs: 2000 },
  'fast-3g': { downKbps: 1638, upKbps: 750, latencyMs: 563 },
  'slow-4g': { downKbps: 1638, upKbps: 750, latencyMs: 150 },
};

function kbpsToBytesPerSecond(kbps: number): number {
  return (kbps * 1024) / 8;
}

export function describeThrottle(spec: PerformanceTestSpec): string {
  const net = NETWORK_PRESETS[spec.throttle.network];
  const cpu = spec.throttle.cpuMultiplier > 1 ? `${spec.throttle.cpuMultiplier}× CPU slowdown` : null;
  const network = net ? `${spec.throttle.network} network` : null;
  const parts = [cpu, network].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'no throttling' : parts.join(', ');
}

// ─── Lighthouse ──────────────────────────────────────────────────────────────

/**
 * Lighthouse's audit ids, mapped to our metric names.
 *
 * `total-blocking-time` rather than an INP audit is not an omission: Lighthouse
 * does not report INP in a lab run either, because nobody interacted with the
 * page. TBT is the lab proxy everyone uses, and the built-in collector only
 * reports a real INP when the spec supplies `interactions`.
 */
const LIGHTHOUSE_AUDITS: Array<[audit: string, metric: PerformanceMetric]> = [
  ['largest-contentful-paint', 'lcpMs'],
  ['cumulative-layout-shift', 'clsScore'],
  ['total-blocking-time', 'tbtMs'],
  ['first-contentful-paint', 'fcpMs'],
  ['server-response-time', 'ttfbMs'],
];

const LIGHTHOUSE_RESOURCE_TYPES: Record<string, PerformanceResourceType> = {
  script: 'js',
  stylesheet: 'css',
  image: 'image',
  font: 'font',
  media: 'media',
  document: 'document',
  other: 'other',
  total: 'total',
};

interface LighthouseAudit {
  numericValue?: unknown;
  details?: { items?: unknown };
}

/**
 * Turn a Lighthouse JSON report into one iteration, or say why we could not.
 *
 * Lighthouse reports a run that failed (`runtimeError`) inside a well-formed
 * report — NO_FCP, a page that never loaded, a redirect loop. Reading the zeros
 * out of one of those would manufacture a perfect score for a page that never
 * rendered, so a runtime error is returned as an error rather than as numbers.
 */
export function parseLighthouseReport(
  raw: string,
  maxOffenders: number,
): { iteration: Iteration } | { error: string } {
  let report: {
    runtimeError?: { code?: string; message?: string };
    audits?: Record<string, LighthouseAudit>;
  };
  try {
    report = JSON.parse(raw) as typeof report;
  } catch (err) {
    return { error: `Lighthouse produced output that is not JSON: ${errText(err)}` };
  }

  if (report.runtimeError?.code) {
    return {
      error: `Lighthouse could not measure the page (${report.runtimeError.code}): ${
        report.runtimeError.message ?? 'no detail given'
      }`,
    };
  }

  const audits = report.audits;
  if (!audits || typeof audits !== 'object') {
    return { error: 'Lighthouse produced a report with no audits in it' };
  }

  const metrics: MetricValues = {};
  for (const [id, metric] of LIGHTHOUSE_AUDITS) {
    const value = audits[id]?.numericValue;
    if (typeof value === 'number' && Number.isFinite(value)) metrics[metric] = value;
  }
  if (Object.keys(metrics).length === 0) {
    return { error: 'Lighthouse reported none of the metrics QAAI budgets on' };
  }

  const bytes = emptyBytes();
  const summaryItems = audits['resource-summary']?.details?.items;
  if (Array.isArray(summaryItems)) {
    for (const item of summaryItems as Array<Record<string, unknown>>) {
      const type = LIGHTHOUSE_RESOURCE_TYPES[String(item.resourceType ?? '')];
      const size = Number(item.transferSize);
      if (type && Number.isFinite(size)) bytes[type] += size;
    }
  }

  const offenders: Offender[] = [];
  const requestItems = audits['network-requests']?.details?.items;
  if (Array.isArray(requestItems)) {
    for (const item of requestItems as Array<Record<string, unknown>>) {
      const url = String(item.url ?? '');
      const size = Number(item.transferSize);
      if (!url || !Number.isFinite(size)) continue;
      offenders.push({
        url,
        type:
          LIGHTHOUSE_RESOURCE_TYPES[String(item.resourceType ?? '').toLowerCase()] ??
          classifyResource(url, ''),
        bytes: size,
      });
    }
  }
  offenders.sort((a, b) => b.bytes - a.bytes);

  // `resource-summary` is a separate audit and can be absent (an older
  // Lighthouse, or `--only-audits`). Rebuilding the totals from the request list
  // is better than reporting zero bytes for a page that clearly downloaded some.
  if (bytes.total === 0 && offenders.length > 0) {
    for (const offender of offenders) {
      bytes[offender.type] += offender.bytes;
      bytes.total += offender.bytes;
    }
  }

  return {
    iteration: {
      metrics,
      bytes,
      offenders: offenders.slice(0, maxOffenders),
      opaqueResources: 0,
      inpUpperBound: false,
      notes: [],
    },
  };
}

/**
 * The argv for one Lighthouse run.
 *
 * The throttling flags are the important part. Lighthouse's default is
 * `simulate` against a mid-tier phone on slow 4G — so the same page measured by
 * Lighthouse and by the built-in collector would produce numbers that differ by
 * a factor of several, and a single budget could not be written against both.
 * Pinning `--throttling-method` to whatever the spec asked for makes the two
 * paths comparable, which is the only way "Lighthouse if present, collector if
 * not" is an acceptable design.
 */
export function lighthouseArgs(
  spec: PerformanceTestSpec,
  url: string,
  outputPath: string,
): string[] {
  const net = NETWORK_PRESETS[spec.throttle.network];
  const throttled = net !== null || spec.throttle.cpuMultiplier > 1;

  const args = [
    url,
    '--output=json',
    `--output-path=${outputPath}`,
    '--quiet',
    '--only-categories=performance',
    // Emulation off: the viewport comes from the window size below, so both
    // engines measure the same layout.
    '--screenEmulation.disabled',
    '--form-factor=desktop',
    `--max-wait-for-load=${spec.navigationTimeoutMs}`,
    `--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --window-size=${spec.viewport.width},${spec.viewport.height}`,
  ];

  if (!throttled) {
    // "provided" means: report what actually happened, simulate nothing.
    args.push('--throttling-method=provided');
    return args;
  }

  args.push('--throttling-method=devtools');
  args.push(`--throttling.cpuSlowdownMultiplier=${spec.throttle.cpuMultiplier}`);
  if (net) {
    args.push(`--throttling.requestLatencyMs=${net.latencyMs}`);
    args.push(`--throttling.downloadThroughputKbps=${net.downKbps}`);
    args.push(`--throttling.uploadThroughputKbps=${net.upKbps}`);
  }
  return args;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
  timedOut: boolean;
}

const OUTPUT_LIMIT = 20_000;

/** Spawned without a shell, args as an array — the spec is data, never a command line. */
function runCommand(opts: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CommandResult> {
  return new Promise<CommandResult>((done) => {
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, CI: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const keepTail = (current: string, chunk: string): string => {
      const next = current + chunk;
      return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout = keepTail(stdout, b.toString());
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = keepTail(stderr, b.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Lighthouse owns a Chrome; a polite SIGTERM can leave it waiting on the
      // child, so escalate rather than hang the whole run.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (result: CommandResult): void => {
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

/** A repo-local Lighthouse beats one on PATH, same as the mutation adapters. */
async function resolveLighthouse(spec: PerformanceTestSpec): Promise<string> {
  if (spec.lighthouseCommand) return spec.lighthouseCommand;
  const local = join(process.cwd(), 'node_modules', '.bin', 'lighthouse');
  try {
    await access(local, FS.X_OK);
    return local;
  } catch {
    return 'lighthouse';
  }
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function step(
  index: number,
  title: string,
  status: 'PASSED' | 'FAILED' | 'SKIPPED',
  message?: string | null,
): StepResult {
  return {
    index,
    title,
    status,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error:
      status === 'FAILED'
        ? {
            message: message ?? 'failed',
            stack: null,
            selector: null,
            expected: null,
            actual: null,
          }
        : null,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A resource URL that is safe — and readable — to print in a step.
 *
 * `maskUrl` is the repo's chokepoint for redacting credentials and sensitive
 * query parameters, but it rebuilds the URL through `URL.toString()`, which
 * percent-encodes the mask itself: a redacted `?token=` comes out as
 * `%E2%80%A2%E2%80%A2…` and reads like corruption rather than like a redaction,
 * in the one place a person is trying to identify a file to delete. Putting the
 * mask characters back is purely cosmetic and cannot un-redact anything — the
 * secret is already gone by the time this runs.
 */
export function displayUrl(raw: string): string {
  return maskUrl(raw).split(encodeURIComponent(SECRET_MASK)).join(SECRET_MASK);
}

const METRIC_HELP: Record<PerformanceMetric, string> = {
  lcpMs: 'https://web.dev/articles/lcp',
  clsScore: 'https://web.dev/articles/cls',
  inpMs: 'https://web.dev/articles/inp',
  tbtMs: 'https://web.dev/articles/tbt',
  fcpMs: 'https://web.dev/articles/fcp',
  ttfbMs: 'https://web.dev/articles/ttfb',
};

/**
 * Total blocking time from raw long tasks.
 *
 * Lighthouse measures TBT between FCP and time-to-interactive. Without a TTI
 * model the honest approximation is "long tasks after FCP", and the docstring
 * says so rather than implying the two numbers are identical. Each long task
 * contributes only the part beyond 50ms, which is the definition.
 */
export function totalBlockingTime(
  longTasks: ReadonlyArray<{ start: number; duration: number }>,
  fcpMs: number | null,
): number {
  const after = fcpMs ?? 0;
  let total = 0;
  for (const task of longTasks) {
    if (task.start + task.duration <= after) continue;
    if (task.duration > 50) total += task.duration - 50;
  }
  return total;
}

// ─── The plugin ──────────────────────────────────────────────────────────────

export const performancePlugin: RunnerPlugin = {
  type: 'PERFORMANCE',

  validate(test: ExecutableTest): void {
    const parsed = performanceTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Performance test "${test.name}" has an invalid spec — ${issues}`);
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = performanceTestSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const secretValues = Object.values(ctx.secrets);
    const clean = (text: string): string => maskSecrets(text, secretValues);

    const findings: Finding[] = [];
    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings,
    };
    const finish = (
      status: TestExecution['status'],
      steps: StepResult[],
      errorMessage: string | null,
    ): TestExecution => ({
      ...base,
      status,
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage,
    });

    const url = /^https?:\/\//i.test(spec.path)
      ? spec.path
      : new URL(spec.path, ctx.baseUrl).toString();

    const steps: StepResult[] = [];
    const notes: string[] = [];

    if (ctx.grid) {
      notes.push(
        'a browser grid is configured for this project and was deliberately ignored — a remote browser measures the round trip to the grid, not what a user experiences',
      );
    }

    // ── Choose the engine ─────────────────────────────────────────────────────
    //
    // One decision, made once, before any iteration runs: mixing engines across
    // iterations would put two differently-calibrated numbers into the same
    // median, which is worse than either engine alone.
    let engine: 'lighthouse' | 'collector' = 'collector';
    let engineNote: string;
    const lighthouseCommand = await resolveLighthouse(spec);

    if (spec.lighthouse === 'off') {
      engineNote = 'built-in Web Vitals collector (Lighthouse disabled by the spec)';
    } else if (spec.interactions.length > 0) {
      // Lighthouse drives its own browser and cannot be told to click anything,
      // so a spec that wants INP has to use the collector. Saying that plainly
      // beats silently reporting no INP.
      engineNote =
        'built-in Web Vitals collector (the spec has interactions, which Lighthouse cannot drive — this is the only way to get a real INP)';
    } else {
      const probe = await runCommand({
        command: lighthouseCommand,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 60_000,
        signal: ctx.signal,
      });
      if (probe.spawnError === null && probe.code === 0) {
        engine = 'lighthouse';
        engineNote = `Lighthouse ${probe.stdout.trim().split('\n')[0] ?? ''}`.trim();
      } else {
        // A NOTE, not a failure and not a skip: the collector below measures the
        // same metrics, so there is a real result either way.
        engineNote =
          'built-in Web Vitals collector — Lighthouse is not installed on this worker ' +
          '(npm i -g lighthouse), which costs the audit detail and nothing else';
      }
    }

    steps.push(
      step(
        steps.length,
        `Engine — ${engineNote} · ${spec.viewport.width}×${spec.viewport.height}, ${describeThrottle(spec)}, cold cache` +
          (notes.length > 0 ? ` · ${notes.join('; ')}` : ''),
        'PASSED',
      ),
    );

    // ── Measure ───────────────────────────────────────────────────────────────
    const iterations: Iteration[] = [];
    const failures: string[] = [];
    let skipReason: string | null = null;

    if (engine === 'lighthouse') {
      const dir = await mkdtemp(join(tmpdir(), 'qaai-perf-'));
      try {
        for (let i = 0; i < spec.iterations; i++) {
          if (ctx.signal.aborted) break;
          const outputPath = join(dir, `lh-${i}.json`);
          const result = await runCommand({
            command: lighthouseCommand,
            args: lighthouseArgs(spec, url, outputPath),
            cwd: dir,
            timeoutMs: spec.lighthouseTimeoutSeconds * 1000,
            signal: ctx.signal,
          });

          if (result.timedOut) {
            failures.push(`load ${i + 1}: Lighthouse exceeded ${spec.lighthouseTimeoutSeconds}s`);
            continue;
          }
          let raw: string;
          try {
            raw = await readFile(outputPath, 'utf8');
          } catch {
            failures.push(
              `load ${i + 1}: Lighthouse wrote no report (exit ${result.code}). ${clean(
                (result.stderr || result.stdout).slice(-300),
              )}`,
            );
            continue;
          }
          const parsed = parseLighthouseReport(raw, spec.maxOffendersReported);
          if ('error' in parsed) {
            failures.push(`load ${i + 1}: ${clean(parsed.error)}`);
            continue;
          }
          iterations.push(parsed.iteration);
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      const collected = await collectWithBrowser(ctx, spec, url, iterations, failures);
      if (collected !== null) skipReason = collected;
    }

    if (skipReason !== null) {
      steps.push(step(steps.length, 'Measurement could not run', 'SKIPPED', skipReason));
      return finish('SKIPPED', steps, skipReason);
    }

    if (ctx.signal.aborted) {
      return finish(
        'SKIPPED',
        steps,
        'The run was cancelled before the performance measurement finished.',
      );
    }

    // ── Is there enough evidence to say anything? ─────────────────────────────
    //
    // The median of two surviving loads out of five is not a median, it is a
    // coin flip with extra steps. Half the requested iterations (and at least
    // one) is the floor; below it there is nothing to judge, and saying so is
    // better than judging anyway.
    const floor = Math.max(1, Math.ceil(spec.iterations / 2));
    const loadStatus = iterations.length >= floor ? 'PASSED' : 'FAILED';
    const loadTitle =
      `Loaded ${url} ${iterations.length}/${spec.iterations} time(s)` +
      (failures.length > 0 ? ` · ${failures.length} load(s) failed: ${failures[0]}` : '');
    steps.push(
      step(
        steps.length,
        loadTitle,
        loadStatus,
        `Only ${iterations.length} of ${spec.iterations} loads produced a measurement, below the ${floor} needed for a median to mean anything. ${failures[0] ?? ''}`.trim(),
      ),
    );

    if (failures.length > 0) {
      findings.push({
        kind: 'PERFORMANCE',
        severity: iterations.length === 0 ? 'CRITICAL' : 'SERIOUS',
        code: 'performance.load-failed',
        message: `${failures.length} of ${spec.iterations} loads of ${spec.path} did not complete: ${failures[0]}`,
        location: spec.path,
        helpUrl: null,
      });
    }

    if (iterations.length < floor) {
      return finish(
        'FAILED',
        steps,
        `The page could not be measured: ${failures[0] ?? 'no load produced a measurement'}`,
      );
    }

    // ── Metric budgets ────────────────────────────────────────────────────────
    const measuredNoBudget: string[] = [];

    for (const metric of PERFORMANCE_METRICS) {
      const budget = spec.budgets[metric];
      const samples = iterations
        .map((it) => it.metrics[metric])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const unit = PERFORMANCE_METRIC_UNITS[metric];
      const label = PERFORMANCE_METRIC_LABELS[metric];

      if (budget === null) {
        const stats = summarise(samples);
        measuredNoBudget.push(
          stats ? `${label.split(' —')[0]} ${formatValue(stats.median, unit)}` : `${label.split(' —')[0]} n/a`,
        );
        continue;
      }

      const verdict = evaluateBudget({
        label,
        unit,
        samples,
        budget,
        spreadTolerance: spec.spreadTolerance,
        unmeasuredReason: unmeasurableReason(metric, spec, engine),
        note:
          metric === 'inpMs' && samples.length > 0 && iterations.every((it) => it.inpUpperBound)
            ? `no interaction lasted long enough for the browser to time it, so ${INP_OBSERVATION_FLOOR_MS}ms is an upper bound and the real INP is below it`
            : undefined,
      });

      steps.push(step(steps.length, verdict.title, verdict.status, verdict.message));

      if (verdict.status === 'FAILED') {
        findings.push({
          kind: 'PERFORMANCE',
          severity: 'SERIOUS',
          code: `performance.budget-exceeded.${metric}`,
          message: verdict.message ?? `${label} exceeded its budget`,
          location: spec.path,
          helpUrl: METRIC_HELP[metric],
        });
      }
      // Instability is reported as its own finding rather than folded into the
      // verdict, so a team can see "this metric cannot be measured reliably on
      // this runner" as a distinct, fixable problem from "this page is slow".
      if (verdict.untrustworthy || (verdict.noisy && (verdict.stats?.n ?? 0) > 1)) {
        findings.push({
          kind: 'PERFORMANCE',
          severity: 'MINOR',
          code: verdict.untrustworthy
            ? `performance.unstable-verdict.${metric}`
            : `performance.noisy-metric.${metric}`,
          message: verdict.title,
          location: spec.path,
          helpUrl: METRIC_HELP[metric],
        });
      }
    }

    if (measuredNoBudget.length > 0) {
      steps.push(
        step(steps.length, `Measured, not budgeted — ${measuredNoBudget.join(' · ')}`, 'PASSED'),
      );
    }

    // ── Byte budgets ──────────────────────────────────────────────────────────
    const byteSummary: string[] = [];
    const opaque = median(iterations.map((it) => it.opaqueResources));

    for (const type of PERFORMANCE_RESOURCE_TYPES) {
      const samplesKb = iterations.map((it) => it.bytes[type] / 1024);
      const budgetKb = spec.byteBudgets[type];
      const stats = summarise(samplesKb);
      if (stats && (stats.median > 0 || type === 'total')) {
        byteSummary.push(`${PERFORMANCE_RESOURCE_LABELS[type]} ${formatValue(stats.median, 'kb')}`);
      }
      if (budgetKb === null) continue;

      const verdict = evaluateBudget({
        label: `${PERFORMANCE_RESOURCE_LABELS[type]} payload`,
        unit: 'kb',
        samples: samplesKb,
        budget: budgetKb,
        spreadTolerance: spec.spreadTolerance,
        unmeasuredReason: `No ${PERFORMANCE_RESOURCE_LABELS[type]} bytes were reported for ${spec.path}, so the budget could not be evaluated.`,
      });

      // The whole point of a byte budget is that it names something to delete,
      // so a failure carries the biggest files of that class rather than a
      // number on its own.
      const offenders = biggestOf(iterations, type, spec.maxOffendersReported).map(
        (o) => `${clean(displayUrl(o.url))} (${formatValue(o.bytes / 1024, 'kb')})`,
      );
      const message =
        verdict.message && offenders.length > 0
          ? `${verdict.message} Largest: ${offenders.join(', ')}.`
          : verdict.message;

      steps.push(step(steps.length, verdict.title, verdict.status, message));

      if (verdict.status === 'FAILED') {
        findings.push({
          kind: 'PERFORMANCE',
          severity: 'MODERATE',
          code: `performance.byte-budget-exceeded.${type}`,
          message: message ?? verdict.title,
          location: spec.path,
          helpUrl: null,
        });
      }
    }

    if (byteSummary.length > 0) {
      steps.push(
        step(
          steps.length,
          `Bytes over the wire (median) — ${byteSummary.join(' · ')}` +
            // A byte total that is missing half the page is not a byte total,
            // and a budget that passes because the bytes were invisible has to
            // say so.
            (opaque > 0
              ? ` · ${Math.round(opaque)} cross-origin resource(s) did not disclose a size (no Timing-Allow-Origin header), so these totals are a floor, not the whole page`
              : ''),
          'PASSED',
        ),
      );
    }

    const failedStep = steps.find((s) => s.status === 'FAILED');
    return finish(
      failedStep ? 'FAILED' : 'PASSED',
      steps,
      failedStep?.error?.message ?? null,
    );
  },
};

/** Why a metric has no samples, phrased as something the reader can act on. */
function unmeasurableReason(
  metric: PerformanceMetric,
  spec: PerformanceTestSpec,
  engine: 'lighthouse' | 'collector',
): string {
  if (metric === 'inpMs') {
    return engine === 'lighthouse'
      ? 'INP cannot be measured in a lab run with no interactions, and Lighthouse cannot be told to click. Add `interactions` to this spec (which switches to the built-in collector), or set `budgets.inpMs` to null and rely on TBT.'
      : 'INP is the delay a user feels after interacting, and nothing interacted with the page. Add `interactions` with the selectors a visitor would click, or set `budgets.inpMs` to null and rely on TBT.';
  }
  if (metric === 'lcpMs') {
    return `The browser never reported a largest contentful paint for ${spec.path}. That happens on a page with no text or image large enough to qualify, or one that never finished rendering — check the page loads what you expect before trusting the other numbers.`;
  }
  return `The browser never reported ${PERFORMANCE_METRIC_LABELS[metric]} for ${spec.path}, so its budget was not evaluated.`;
}

/** The biggest individual files of one class, across the measured loads. */
function biggestOf(
  iterations: readonly Iteration[],
  type: PerformanceResourceType,
  limit: number,
): Offender[] {
  const bySize = new Map<string, Offender>();
  for (const iteration of iterations) {
    for (const offender of iteration.offenders) {
      if (type !== 'total' && offender.type !== type) continue;
      const existing = bySize.get(offender.url);
      if (!existing || offender.bytes > existing.bytes) bySize.set(offender.url, offender);
    }
  }
  return [...bySize.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/**
 * The built-in path: N cold loads in the pooled browser.
 *
 * Returns null on success, or a sentence explaining why nothing could be
 * measured at all (which the caller turns into a SKIP, not a failure — a worker
 * without a browser is our problem, not the customer's).
 *
 * A fresh context per iteration is not an accident. It is what makes every load
 * a COLD load, which is the only way five iterations measure the same thing; the
 * second load of a reused context would be a cache-hit benchmark wearing a
 * Core Web Vitals costume. It is also what the browser pool requires: the
 * browser is shared, the context never is.
 */
async function collectWithBrowser(
  ctx: RunContext,
  spec: PerformanceTestSpec,
  url: string,
  out: Iteration[],
  failures: string[],
): Promise<string | null> {
  let lease: Awaited<ReturnType<typeof acquireBrowser>>;
  try {
    lease = await acquireBrowser();
  } catch (err) {
    const message = errText(err);
    if (isMissingBrowserError(message)) {
      return 'Chromium is not installed on this worker, so nothing was measured. Install it with `npx playwright install chromium` and re-run — the page itself was not evaluated.';
    }
    return `A browser could not be started on this worker, so nothing was measured: ${message}`;
  }

  try {
    for (let i = 0; i < spec.iterations; i++) {
      if (ctx.signal.aborted) break;

      let context: BrowserContext | null = null;
      try {
        context = await lease.browser.newContext({
          viewport: { width: spec.viewport.width, height: spec.viewport.height },
          deviceScaleFactor: 1,
          ...(ctx.storageState ? { storageState: ctx.storageState as never } : {}),
        });
        const page = await context.newPage();

        const throttleProblem = await applyThrottling(context, page, spec);
        if (throttleProblem !== null) {
          // The budgets were written for a throttled profile. Measuring
          // unthrottled and checking them anyway would manufacture a pass, so
          // the whole test stops and says why.
          return throttleProblem;
        }

        // Before the first byte: FCP and most layout shifts happen during load,
        // and an observer registered afterwards has already missed them.
        await page.addInitScript({ content: COLLECT_SCRIPT });

        await page.goto(url, { waitUntil: 'load', timeout: spec.navigationTimeoutMs });
        const loadedNonce = await page.evaluate<string | null>(NONCE_SCRIPT);

        for (const interaction of spec.interactions) {
          await page
            .locator(interaction.selector)
            .first()
            .click({ timeout: 10_000 });
          if (interaction.settleMs > 0) await page.waitForTimeout(interaction.settleMs);
        }

        // LCP is not final until the page stops painting, and CLS keeps
        // accumulating; cutting this short systematically under-reports both.
        if (spec.settleMs > 0) await page.waitForTimeout(spec.settleMs);

        const raw = await page.evaluate<RawPageData>(READ_SCRIPT);

        /*
         * The page we are reading has to be the page we measured.
         *
         * The very first live run caught this: an `interactions` entry pointing
         * at an `<a>` navigated the browser, and the plugin cheerfully reported
         * the DESTINATION's LCP as the home page's — a wrong number delivered
         * with total confidence, which is worse than no number. The collector's
         * nonce is per-document, so a mismatch means the document changed under
         * us and this load has to be discarded rather than believed.
         */
        if (loadedNonce === null || raw.nonce !== loadedNonce) {
          throw new Error(
            `the document changed after it loaded — an interaction or a client-side redirect ` +
              `navigated away from ${spec.path}, so these numbers would describe a different page. ` +
              `Point \`interactions\` at a control that does not navigate, or measure the destination directly.`,
          );
        }

        out.push(toIteration(raw, spec));
      } catch (err) {
        failures.push(`load ${out.length + failures.length + 1}: ${errText(err).split('\n')[0]}`);
      } finally {
        await context?.close().catch(() => {});
      }
    }
  } finally {
    // release(), never close(): the browser belongs to the pool and to every
    // other test in this worker.
    await lease.release();
  }

  return null;
}

/**
 * Applies the spec's CPU and network profile over CDP. Returns null when there
 * is nothing to do or it worked, and a sentence when a REQUESTED profile could
 * not be applied.
 */
async function applyThrottling(
  context: BrowserContext,
  page: Page,
  spec: PerformanceTestSpec,
): Promise<string | null> {
  const net = NETWORK_PRESETS[spec.throttle.network];
  if (net === null && spec.throttle.cpuMultiplier <= 1) return null;

  try {
    const session = await context.newCDPSession(page);
    if (spec.throttle.cpuMultiplier > 1) {
      await session.send('Emulation.setCPUThrottlingRate', { rate: spec.throttle.cpuMultiplier });
    }
    if (net) {
      await session.send('Network.enable');
      await session.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: net.latencyMs,
        downloadThroughput: kbpsToBytesPerSecond(net.downKbps),
        uploadThroughput: kbpsToBytesPerSecond(net.upKbps),
      });
    }
    return null;
  } catch (err) {
    return (
      `This spec asks for ${describeThrottle(spec)}, which this worker's browser could not apply ` +
      `(${errText(err)}). Measuring unthrottled would check the budgets against numbers they were ` +
      'not written for, so nothing was evaluated. Run this test on a Chromium worker, or remove `throttle`.'
    );
  }
}

/** Raw page data → one iteration. Every number is re-checked; the page is not trusted. */
export function toIteration(raw: RawPageData, spec: PerformanceTestSpec): Iteration {
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

  const metrics: MetricValues = {};
  const lcp = num(raw.lcp);
  if (lcp !== undefined) metrics.lcpMs = lcp;
  const fcp = num(raw.fcp);
  if (fcp !== undefined) metrics.fcpMs = fcp;
  const cls = num(raw.cls);
  if (cls !== undefined) metrics.clsScore = cls;
  const ttfb = num(raw.ttfb);
  if (ttfb !== undefined) metrics.ttfbMs = ttfb;

  const longTasks = Array.isArray(raw.longTasks) ? raw.longTasks : [];
  metrics.tbtMs = totalBlockingTime(longTasks, fcp ?? null);

  /*
   * INP, and the difference between "nobody clicked" and "everything was
   * instant".
   *
   * The event observer cannot report anything under a 16ms threshold — that is
   * the platform minimum, not a choice — so a page that responds in 4ms hands us
   * zero entries, exactly like a page nobody touched. `interactionCount` tells
   * the two apart. When interactions happened but none were slow enough to time,
   * the honest answer is an UPPER BOUND of 16ms: we know the real INP is below
   * it, which is precisely what a ceiling budget needs. Reporting 0 would invent
   * a perfect score, and skipping would throw away a usable verdict.
   */
  const interactionDurations = (raw.interactionDurations ?? []).filter(
    (d): d is number => typeof d === 'number' && Number.isFinite(d),
  );
  const interactionCount = num(raw.interactionCount) ?? 0;
  let inpUpperBound = false;
  if (interactionDurations.length > 0) {
    metrics.inpMs = Math.max(...interactionDurations);
  } else if (interactionCount > 0) {
    metrics.inpMs = INP_OBSERVATION_FLOOR_MS;
    inpUpperBound = true;
  }

  const bytes = emptyBytes();
  const offenders: Offender[] = [];
  let opaqueResources = 0;

  const documentBytes = num(raw.documentBytes) ?? 0;
  bytes.document += documentBytes;
  bytes.total += documentBytes;

  for (const resource of raw.resources ?? []) {
    const type = classifyResource(resource.url, resource.initiatorType);
    // transferSize is 0 for a cross-origin response without Timing-Allow-Origin
    // AND for a cache hit. encodedBodySize rescues the second case; the first is
    // counted and reported, because a byte total missing half the page must not
    // pass a budget quietly.
    const size = num(resource.transferSize) || num(resource.encodedBodySize) || 0;
    if (size === 0) opaqueResources++;
    bytes[type] += size;
    bytes.total += size;
    offenders.push({ url: resource.url, type, bytes: size });
  }

  offenders.sort((a, b) => b.bytes - a.bytes);

  return {
    metrics,
    bytes,
    // Keep a few more than the report shows, so `biggestOf` can pick per class.
    offenders: offenders.slice(0, Math.max(spec.maxOffendersReported * 4, 20)),
    opaqueResources,
    inpUpperBound,
    notes: raw.observerErrors ?? [],
  };
}
