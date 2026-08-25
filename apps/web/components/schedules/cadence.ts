/**
 * Saying a cadence out loud.
 *
 * `0 3 * * 1-5` is not a thing a person reads. It is a thing a person decodes,
 * slowly, and gets wrong — and the whole reason the schedules screen exists is
 * that nobody could see what their automation actually does. So every row says
 * "every weekday at 3:00 AM", and the expression itself is demoted to a mono
 * detail underneath for the people who want to check the working.
 *
 * ─── Why this refuses to guess ──────────────────────────────────────────────
 *
 * Cron has corners that cannot be put into a short English phrase without
 * losing something, and a phrase that is nearly right is worse than the raw
 * expression, because the raw expression at least announces that you have to
 * think. The two that matter:
 *
 *   · DAY-OF-MONTH AND DAY-OF-WEEK TOGETHER. `0 3 1 * 1` fires on the 1st OR on
 *     every Monday — cron ORs those two fields rather than ANDing them, which
 *     is the single most misread rule in the format. Any phrase short enough
 *     for a table row reads as "and".
 *   · A RESTRICTED MONTH, an hour list, a minute list, and the non-standard
 *     `L`, `W`, `#` and `?` operators. Each is describable in a sentence and
 *     none in a phrase.
 *
 * All of those come back as `{ kind: 'expression' }`, which the UI renders as
 * the cron in mono with no English at all. That is the honest answer, and it is
 * tested as carefully as the ones that succeed.
 *
 * The line is drawn at ONE restricted field. `0 3 * * 1-5` is described because
 * a fixed time plus a set of days is a phrase; an every-two-hours cron crossed
 * with `1-5` is not, because every phrasing of a recurring interval crossed
 * with a set of days either runs to a sentence or drops one of the two halves.
 * Widening this is a matter of adding a case and a test, never of loosening the
 * fallback.
 *
 * ─── And why the timezone is never optional ─────────────────────────────────
 *
 * "3:00 AM" is a half-truth. The worker's sweep parses each schedule's cron in
 * that schedule's OWN stored `timezone` (see apps/worker/src/processors/
 * schedule.ts, which passes `tz: schedule.timezone` to cron-parser) — not in
 * the browser's zone and not in the org's. So the zone that gets printed is the
 * stored one, resolved to its current UTC offset so it is legible even when it
 * is a name the reader does not recognise.
 *
 * Pure and dependency-free on purpose: apps/web has no jsdom, so this is the
 * layer that can actually be tested, and the components stay thin enough that
 * typecheck plus a build is honest coverage for them.
 */

export type Cadence =
  /** Describable: render `text` as prose, the expression as a detail. */
  | { kind: 'words'; text: string }
  /** Not describable: render the expression itself and claim nothing. */
  | { kind: 'expression'; text: string };

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Operators this module deliberately does not describe. See the header. */
const UNDESCRIBABLE = /[LW#?]/i;

/** `3` → 3, anything else → null. No sign, no whitespace, no leading `+`. */
function asInt(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The set of values a field selects, or null when the shape is not one this
 * module handles. `*` returns null too — callers check for it separately,
 * because "every" and "these three" are different sentences.
 */
function expand(field: string, min: number, max: number): number[] | null {
  const out: number[] = [];
  for (const part of field.split(',')) {
    if (part === '') return null;
    const range = part.split('-');
    if (range.length === 1) {
      const value = asInt(range[0]!);
      if (value === null || value < min || value > max) return null;
      out.push(value);
      continue;
    }
    if (range.length !== 2) return null;
    const from = asInt(range[0]!);
    const to = asInt(range[1]!);
    if (from === null || to === null) return null;
    if (from < min || to > max || from > to) return null;
    for (let i = from; i <= to; i++) out.push(i);
  }
  // Duplicates are legal in cron and meaningless in a sentence.
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Does `a star-slash-N step` over a field of `range` values actually repeat every N?
 *
 * Only when N divides the range. Cron steps restart at the top of each field,
 * so `star-slash-7` on minutes fires at :00 :07 … :56 and then :00 — a four-minute gap,
 * not seven. Calling that "every 7 minutes" is exactly the confident wrong
 * sentence this module exists to refuse: somebody reads it, expects a check
 * every seven minutes, and gets an uneven one forever without ever being told.
 *
 * When it does not divide, the expression is shown instead. A cron string a
 * person has to look up is worse than a sentence — but a sentence that is
 * false is worse than both.
 */
const stepIsEven = (step: number, range: number): boolean => range % step === 0;

/** A star-slash-N step field to its N. Null for anything else, `*` included. */
function stepOfEvery(field: string): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  if (!match) return null;
  const step = asInt(match[1]!);
  return step !== null && step > 0 ? step : null;
}

/** `3:00 AM`, `12:30 PM`. Midnight is 12:00 AM, which is what a clock says. */
export function clockTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** `1st`, `2nd`, `3rd`, `11th`, `21st`. */
export function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
  return `${value}${suffix}`;
}

/** `a`, `a and b`, `a, b and c`. The serial comma is deliberately absent. */
export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Day numbers to a phrase. Cron treats 0 and 7 as Sunday, so both normalise
 * before anything else — `0,6` and `6,7` are the same weekend.
 */
function daysPhrase(days: number[]): string {
  const normalised = [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b);
  const key = normalised.join(',');
  if (key === '1,2,3,4,5') return 'every weekday';
  if (key === '0,6') return 'every weekend day';
  if (key === '0,1,2,3,4,5,6') return 'every day';
  return `every ${joinList(normalised.map((d) => DAY_NAMES[d]!))}`;
}

/**
 * A five-field cron expression, in words — or the expression back, unchanged.
 *
 * Only standard five-field crons are described. A six-field expression (the
 * seconds variant some parsers accept) is handed back as-is rather than
 * silently read as if the leading field were minutes, which would report a
 * schedule an hour's worth of wrong.
 */
export function describeCron(cron: string): Cadence {
  const raw = cron.trim();
  const fields = raw.split(/\s+/);
  const asExpression: Cadence = { kind: 'expression', text: raw };

  if (fields.length !== 5 || UNDESCRIBABLE.test(raw)) return asExpression;

  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // A restricted month is describable only as a sentence, not as a phrase.
  if (monthField !== '*') return asExpression;

  const everyDom = domField === '*';
  const everyDow = dowField === '*';
  // The OR trap. See the header — this is the case that must never be guessed.
  if (!everyDom && !everyDow) return asExpression;

  // ── Sub-hourly: no fixed hour, so the day fields have to be open too ──────
  const minuteStep = stepOfEvery(minuteField);
  if (minuteField === '*' || minuteStep !== null) {
    if (hourField !== '*' || !everyDom || !everyDow) return asExpression;
    if (minuteField === '*' || minuteStep === 1) return { kind: 'words', text: 'every minute' };
    // 60 minutes in the field. A step that does not divide it wraps unevenly.
    if (minuteStep === null || !stepIsEven(minuteStep, 60)) return asExpression;
    return { kind: 'words', text: `every ${minuteStep} minutes` };
  }

  // Everything below fires at a fixed minute of the hour.
  const minute = asInt(minuteField);
  if (minute === null || minute > 59) return asExpression;

  // ── Hourly, and every-N-hours ────────────────────────────────────────────
  const hourStep = stepOfEvery(hourField);
  if (hourField === '*' || hourStep !== null) {
    if (!everyDom || !everyDow) return asExpression;
    const past =
      minute === 0 ? 'on the hour' : `at ${minute} minute${minute === 1 ? '' : 's'} past`;
    if (hourField === '*' || hourStep === 1) return { kind: 'words', text: `every hour, ${past}` };
    // 24 hours in the field, same rule: `star-slash-7` is 0,7,14,21 and then 0 — a
    // three-hour gap that "every 7 hours" would misdescribe once a day.
    if (hourStep === null || !stepIsEven(hourStep, 24)) return asExpression;
    return { kind: 'words', text: `every ${hourStep} hours, ${past}` };
  }

  const hour = asInt(hourField);
  if (hour === null || hour > 23) return asExpression;
  const at = clockTime(hour, minute);

  // ── A fixed day of the month ─────────────────────────────────────────────
  if (!everyDom) {
    const days = expand(domField, 1, 31);
    if (!days || days.length === 0) return asExpression;
    return {
      kind: 'words',
      text: `on the ${joinList(days.map(ordinal))} of every month at ${at}`,
    };
  }

  // ── A fixed day of the week ──────────────────────────────────────────────
  if (!everyDow) {
    const days = expand(dowField, 0, 7);
    if (!days || days.length === 0) return asExpression;
    return { kind: 'words', text: `${daysPhrase(days)} at ${at}` };
  }

  return { kind: 'words', text: `every day at ${at}` };
}

/**
 * A monitor's interval in words. Monitors have no cron — the worker simply
 * re-checks `intervalMinutes` after the last check — so this is a much smaller
 * problem than the one above, and it has no timezone at all: an interval means
 * the same thing everywhere, which is worth not implying otherwise.
 */
export function describeInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return 'every check';
  if (minutes === 1) return 'every minute';
  if (minutes < 60) return `every ${minutes} minutes`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 24) return 'every day';
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `every ${hours}h ${rest}m`;
}

export interface ZoneLabel {
  /** What to print: `UTC`, `Europe/Berlin (UTC+02:00)`, or the raw string. */
  text: string;
  /** False when the scheduler cannot resolve it — the worker will disable it. */
  valid: boolean;
}

/**
 * The zone a schedule actually fires in, with its offset spelled out.
 *
 * The offset is resolved AT A GIVEN INSTANT rather than stated once, because
 * half the world's zones have two of them: printing "Europe/Berlin (UTC+01:00)"
 * in July is exactly the kind of confidently-wrong detail this screen is meant
 * to remove. `at` is a parameter and not `new Date()` so this stays pure and
 * the summer and winter cases are both testable.
 *
 * An unresolvable zone is reported as such rather than quietly falling back to
 * UTC, because the worker does not fall back either — it fails to parse the
 * cron and switches the schedule off.
 */
export function formatZone(timezone: string, at: Date): ZoneLabel {
  let offset: string;
  try {
    offset =
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return { text: timezone, valid: false };
  }

  // ICU says GMT; this product says UTC everywhere else, and two names for one
  // thing on one screen is a reader wondering whether they differ.
  const utc = offset.replace(/^GMT/, 'UTC') || 'UTC';
  const normalised = utc === 'UTC' ? 'UTC+00:00' : utc;
  if (normalised === 'UTC+00:00' && (timezone === 'UTC' || timezone === 'Etc/UTC')) {
    return { text: 'UTC', valid: true };
  }
  return { text: `${timezone} (${normalised})`, valid: true };
}

export interface MonitorStreak {
  consecutiveFailures: number;
  failureThreshold: number;
  enabled: boolean;
}

/**
 * The whole state of a monitor in one line.
 *
 * "3 consecutive failures, alerts at 5" is what a person needs at a glance, and
 * it is the one thing a schedule's row cannot say — a monitor does not page on
 * a failure, it pages on a STREAK, and a monitor sitting one short of its
 * threshold is a different situation from a monitor that is merely red.
 */
export function describeStreak(monitor: MonitorStreak): string {
  const { consecutiveFailures: streak, failureThreshold: threshold, enabled } = monitor;
  if (!enabled) return 'paused — not checking';
  if (streak === 0) return `passing · alerts after ${threshold} in a row`;
  if (streak >= threshold) {
    return `${streak} consecutive failure${streak === 1 ? '' : 's'} · alerted at ${threshold}`;
  }
  return `${streak} consecutive failure${streak === 1 ? '' : 's'} · alerts at ${threshold}`;
}

/**
 * `in 4h`, `in 12m` — the future counterpart of `shortAgo` in setup/time.ts,
 * and rounded down for the same reason: this sits next to the exact time, and a
 * column of ages the eye can compare is worth more than a rounded-up guess.
 *
 * A fire time in the past is not an error. The worker sweeps on an interval, so
 * a schedule genuinely sits overdue for a few seconds every time it fires, and
 * a paused one can sit overdue for a week.
 */
export function shortUntil(iso: string, now: number): string {
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return '';
  const seconds = Math.floor((target - now) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return 'in <1m';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/**
 * A timestamp on the schedule's OWN clock — `Tue, 3:00 AM`.
 *
 * Rendered in the stored zone rather than the reader's, because that is the
 * clock the run happens on and translating it into the viewer's zone is how two
 * people looking at the same nightly come away with two different answers about
 * when it runs. The zone itself is printed alongside by the row, so the reader
 * knows which clock they are being shown.
 */
export function timeInZone(iso: string, timezone: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  // An unresolvable zone still gets a true statement about the instant; the row
  // separately says the zone itself is one the scheduler will refuse.
  const zone = resolvableZone(timezone) ? timezone : 'UTC';

  /*
   * Assembled from parts rather than taken from `format()`, because ICU is not
   * self-consistent about the separator: the same options produce "Tue, 2:00 AM"
   * for Europe/Berlin and "Tue 2:00 AM" for UTC, so a list of schedules would
   * punctuate itself differently row by row depending on the zone stored.
   */
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  return `${part('weekday')}, ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

function resolvableZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
