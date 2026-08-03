import type { ConsoleEntry, EvidenceStep, NetworkEntry } from '../EvidenceRail';
import { duration } from '../ui';

/**
 * Correlating the evidence with the step that failed.
 *
 * The rail used to show the console and the network for the whole test. When a
 * test does forty things and the twelfth broke, the request that explains it is
 * the twelfth of forty and the list is a haystack. Everything the triage rail
 * renders is scoped to the selected step first, with the full list always one
 * click away — evidence is defaulted away, never hidden.
 *
 * The types stay in components/EvidenceRail.tsx, which is where they were first
 * written down; only the correlation moved here, because the rail that uses it
 * now lives in this folder.
 */

/**
 * A console line is emitted by the page a beat before the assertion that
 * notices it, and the runner stamps a step's start after the action has begun.
 * So the window is the step's own span with a small lead-in — wide enough to
 * catch the error that caused the failure, narrow enough that "the console for
 * this step" still means something.
 */
const LEAD_MS = 500;
export const TAIL_MS = 250;

/** Named for what it is, and NOT `Window` — that shadows a DOM global. */
export interface LogWindow {
  from: number;
  to: number;
}

/**
 * The time window for a step, or null when the timestamps cannot support one.
 *
 * Not every runner plugin stamps a distinct `startedAt` per step — the API and
 * security plugins record the same instant for every step in the test. Windowing
 * against those would either show everything or show nothing while claiming to
 * be precise, so when the stamps do not discriminate we return null and the
 * caller shows the unfiltered log with a note saying why. Silently filtering on
 * a timestamp we do not trust is how evidence goes missing.
 */
export function stepWindow(steps: EvidenceStep[], step: EvidenceStep): LogWindow | null {
  if (!step.startedAt) return null;
  const stamps = new Set(steps.map((s) => s.startedAt).filter(Boolean));
  if (steps.length > 1 && stamps.size < 2) return null;
  const start = new Date(step.startedAt).getTime();
  if (Number.isNaN(start)) return null;
  return { from: start - LEAD_MS, to: start + Math.max(0, step.durationMs) + TAIL_MS };
}

/**
 * Where an entry sits relative to the step, as a signed offset.
 *
 * `−120ms` rather than "120ms before": the column is 40px wide and holds twenty
 * of these, and a sign is read at a glance where a word has to be parsed.
 */
export function offsetLabel(atMs: number, step: EvidenceStep): string | null {
  if (!step.startedAt) return null;
  const start = new Date(step.startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const delta = atMs - start;
  if (delta < 0) return `−${duration(Math.round(-delta))}`;
  if (delta <= Math.max(0, step.durationMs)) return 'during';
  return `+${duration(Math.round(delta - step.durationMs))}`;
}

/** The path of a URL, for matching and for display. Falsy-safe on junk input. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * How much a request has to do with this step.
 *
 * NOTE — network entries carry NO absolute timestamp. `NetworkEntry` is
 * `{method, url, status, durationMs, responseBodySnippet}`; the runner has the
 * wall-clock time at capture and drops it (packages/runner/src/plugins/*).
 * So this cannot be a time window like the console is, and pretending otherwise
 * would put a confident, wrong label on the evidence. What it can do honestly is
 * rank: a request the step's own error names is almost certainly the one, a
 * request that failed or never completed is almost always worth reading, and
 * everything else is a click away.
 */
const NAMED_BY_STEP = 3;
const FAILED_ANYWHERE = 2;

export function relevance(entry: NetworkEntry, tokens: string[]): number {
  if (namedByStep(entry, tokens)) return NAMED_BY_STEP;
  if (entry.status === null) return FAILED_ANYWHERE; // never completed — a hang or a reset
  if (entry.status >= 400) return FAILED_ANYWHERE;
  return 0;
}

/**
 * Does the step name this request?
 *
 * Matching runs against TOKENS, not against the raw string. A plain
 * `haystack.includes(path)` cannot match the root path — "/" is a substring of
 * every URL-shaped word in the text, so it has to be excluded, and then a step
 * titled `Headers and cookies: /` fails to match its own request to `/`. That
 * was not hypothetical: it is exactly what the security-smoke test does, and
 * the rail hid the one request the step was about while showing two 404s from
 * other steps. An exact token comparison handles the short paths and substring
 * matching handles the long ones.
 */
export function namedByStep(entry: NetworkEntry, tokens: string[]): boolean {
  const path = pathOf(entry.url);
  for (const token of tokens) {
    if (token === entry.url || token === path) return true;
    if (path.length > 1 && token.includes(path)) return true;
  }
  return false;
}

/** Everything the step says about itself, split into words to match URLs against. */
export function stepTokens(step: EvidenceStep): string[] {
  return [step.title, step.errorMessage, step.expected, step.actual, step.selector]
    .filter(Boolean)
    .join('\n')
    .split(/[\s"'`(),;<>[\]{}]+/)
    .filter(Boolean);
}

/**
 * "An error logged milliseconds before the failure is usually the answer."
 *
 * The nearest error at or before the step's end — deliberately NOT limited to
 * the window, because an error logged two seconds earlier during a navigation
 * is still the explanation and burying it under a scroll would be the exact
 * failure this rail exists to fix. The offset is spelled out so nobody mistakes
 * it for something logged inside the step.
 */
export function nearestErrorTo(
  consoleLog: ConsoleEntry[],
  step: EvidenceStep | null,
): { entry: ConsoleEntry; label: string | null } | null {
  if (!step?.startedAt || step.status !== 'FAILED') return null;
  const end = new Date(step.startedAt).getTime() + Math.max(0, step.durationMs) + TAIL_MS;
  if (Number.isNaN(end)) return null;
  let best: ConsoleEntry | null = null;
  let bestAt = -Infinity;
  for (const entry of consoleLog) {
    if (entry.level !== 'error') continue;
    const at = new Date(entry.at).getTime();
    if (Number.isNaN(at) || at > end) continue;
    if (at >= bestAt) {
      best = entry;
      bestAt = at;
    }
  }
  return best ? { entry: best, label: offsetLabel(bestAt, step) } : null;
}
