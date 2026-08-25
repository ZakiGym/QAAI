/**
 * Tests for the cadence language (§6).
 *
 * The expected strings here are written by hand, never derived from the module.
 * That is the point: a test that asks `describeCron` what it thinks and then
 * checks it said that would pass with every phrase in the file reversed. Each
 * case below is a cron somebody would plausibly type and the sentence a person
 * would plausibly say, decided independently.
 *
 * Two halves get equal weight. The first is the descriptions. The second is the
 * REFUSALS — every expression the module must hand back untouched — because the
 * failure mode that matters is not an ugly phrase, it is a confident phrase for
 * a cron that does something else. `0 3 1 * 1` fires on the 1st OR on Mondays,
 * and there is no short phrase that does not read as "and".
 */

import { describe, expect, it } from 'vitest';
import {
  clockTime,
  describeCron,
  describeInterval,
  describeStreak,
  formatZone,
  joinList,
  ordinal,
  shortUntil,
  timeInZone,
} from './cadence';

/** Shorthand: the words, or a marker that the module declined to describe it. */
const words = (cron: string): string => {
  const result = describeCron(cron);
  return result.kind === 'words' ? result.text : `<expression:${result.text}>`;
};

describe('describeCron — the ones it can say', () => {
  it('describes a weeknight nightly, the example the product is built around', () => {
    expect(words('0 3 * * 1-5')).toBe('every weekday at 3:00 AM');
  });

  it('describes a daily run, including midnight and noon', () => {
    expect(words('0 0 * * *')).toBe('every day at 12:00 AM');
    expect(words('0 12 * * *')).toBe('every day at 12:00 PM');
    expect(words('30 17 * * *')).toBe('every day at 5:30 PM');
  });

  it('describes sub-hourly steps', () => {
    expect(words('*/15 * * * *')).toBe('every 15 minutes');
    expect(words('*/5 * * * *')).toBe('every 5 minutes');
    expect(words('* * * * *')).toBe('every minute');
    expect(words('*/1 * * * *')).toBe('every minute');
  });

  it('describes hourly, and says where in the hour it lands', () => {
    expect(words('0 * * * *')).toBe('every hour, on the hour');
    expect(words('30 * * * *')).toBe('every hour, at 30 minutes past');
    expect(words('1 * * * *')).toBe('every hour, at 1 minute past');
    expect(words('15 */4 * * *')).toBe('every 4 hours, at 15 minutes past');
  });

  it('names a single weekday', () => {
    expect(words('0 9 * * 1')).toBe('every Monday at 9:00 AM');
    expect(words('45 23 * * 6')).toBe('every Saturday at 11:45 PM');
  });

  it('treats both 0 and 7 as Sunday, so the same schedule reads the same way', () => {
    expect(words('0 4 * * 0')).toBe('every Sunday at 4:00 AM');
    expect(words('0 4 * * 7')).toBe('every Sunday at 4:00 AM');
    expect(words('0 4 * * 0,6')).toBe('every weekend day at 4:00 AM');
    expect(words('0 4 * * 6,7')).toBe('every weekend day at 4:00 AM');
  });

  it('lists several weekdays', () => {
    expect(words('0 8 * * 1,4')).toBe('every Monday and Thursday at 8:00 AM');
    expect(words('0 8 * * 1,3,5')).toBe('every Monday, Wednesday and Friday at 8:00 AM');
    expect(words('0 8 * * 1-3')).toBe('every Monday, Tuesday and Wednesday at 8:00 AM');
  });

  it('collapses a full week back to "every day"', () => {
    expect(words('0 2 * * 0-6')).toBe('every day at 2:00 AM');
  });

  it('describes a day of the month', () => {
    expect(words('0 3 1 * *')).toBe('on the 1st of every month at 3:00 AM');
    expect(words('0 3 15 * *')).toBe('on the 15th of every month at 3:00 AM');
    expect(words('0 3 1,15 * *')).toBe('on the 1st and 15th of every month at 3:00 AM');
    expect(words('0 3 22 * *')).toBe('on the 22nd of every month at 3:00 AM');
  });

  it('ignores surrounding whitespace and runs of spaces between fields', () => {
    expect(words('  0   3  *  *  1-5 ')).toBe('every weekday at 3:00 AM');
  });
});

describe('describeCron — the ones it refuses to say', () => {
  /*
   * The headline refusal. Cron ORs day-of-month against day-of-week, so this
   * runs on the 1st AND on every Monday — thirteen or so times a month, not
   * once. Every short phrase for it reads as an intersection.
   */
  it('refuses day-of-month and day-of-week together', () => {
    expect(describeCron('0 3 1 * 1')).toEqual({ kind: 'expression', text: '0 3 1 * 1' });
  });

  it('refuses a restricted month', () => {
    expect(describeCron('0 3 * 6 *').kind).toBe('expression');
    expect(describeCron('0 3 1 1-3 *').kind).toBe('expression');
  });

  it('refuses hour and minute lists', () => {
    expect(describeCron('0 0,12 * * *').kind).toBe('expression');
    expect(describeCron('0,30 3 * * *').kind).toBe('expression');
    expect(describeCron('0 9-17 * * *').kind).toBe('expression');
  });

  it('refuses a step crossed with a restricted day set', () => {
    expect(describeCron('0 */2 * * 1-5').kind).toBe('expression');
    expect(describeCron('*/10 * * * 1').kind).toBe('expression');
    expect(describeCron('*/10 3 * * *').kind).toBe('expression');
  });

  it('refuses the non-standard operators rather than dropping them', () => {
    for (const cron of ['0 3 L * *', '0 3 * * 1#2', '0 3 15W * *', '0 3 ? * 1']) {
      expect(describeCron(cron), cron).toEqual({ kind: 'expression', text: cron });
    }
  });

  /*
   * A six-field expression leads with SECONDS. Read as five fields it would be
   * described an hour's worth of wrong, which is worse than not describing it.
   */
  it('refuses anything that is not five fields', () => {
    expect(describeCron('0 0 3 * * 1-5').kind).toBe('expression');
    expect(describeCron('0 3 * *').kind).toBe('expression');
    expect(describeCron('').kind).toBe('expression');
  });

  it('refuses out-of-range and malformed fields instead of printing nonsense', () => {
    for (const cron of [
      '99 3 * * *',
      '0 25 * * *',
      '0 3 0 * *',
      '0 3 32 * *',
      '0 3 * * 8',
      '0 3 5-1 * *',
      'a b c d e',
      '0 3 * * 1-',
      '*/0 * * * *',
    ]) {
      expect(describeCron(cron).kind, cron).toBe('expression');
    }
  });

  it('hands back the trimmed expression, so the UI has something to render', () => {
    expect(describeCron('  0 0,12 * * *  ')).toEqual({
      kind: 'expression',
      text: '0 0,12 * * *',
    });
  });
});

describe('clockTime', () => {
  it('says what a clock says at the two ends of the day', () => {
    expect(clockTime(0, 0)).toBe('12:00 AM');
    expect(clockTime(0, 5)).toBe('12:05 AM');
    expect(clockTime(12, 0)).toBe('12:00 PM');
    expect(clockTime(11, 59)).toBe('11:59 AM');
    expect(clockTime(13, 7)).toBe('1:07 PM');
    expect(clockTime(23, 30)).toBe('11:30 PM');
  });
});

describe('ordinal', () => {
  it('handles the teens, which are the ones every naive version gets wrong', () => {
    expect(['', ordinal(1), ordinal(2), ordinal(3), ordinal(4)].slice(1)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
    ]);
    expect([ordinal(11), ordinal(12), ordinal(13)]).toEqual(['11th', '12th', '13th']);
    expect([ordinal(21), ordinal(22), ordinal(23)]).toEqual(['21st', '22nd', '23rd']);
    expect(ordinal(31)).toBe('31st');
  });
});

describe('joinList', () => {
  it('joins the way a person writes a list', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('describeInterval', () => {
  it('says a monitor cadence in the unit a person would use', () => {
    expect(describeInterval(1)).toBe('every minute');
    expect(describeInterval(15)).toBe('every 15 minutes');
    expect(describeInterval(60)).toBe('every hour');
    expect(describeInterval(120)).toBe('every 2 hours');
    expect(describeInterval(1440)).toBe('every day');
    expect(describeInterval(90)).toBe('every 1h 30m');
  });

  it('does not invent a cadence for a value the API would have refused', () => {
    expect(describeInterval(0)).toBe('every check');
    expect(describeInterval(-5)).toBe('every check');
    expect(describeInterval(Number.NaN)).toBe('every check');
  });
});

describe('formatZone', () => {
  const july = new Date('2026-07-01T12:00:00Z');
  const january = new Date('2026-01-01T12:00:00Z');

  it('resolves the offset at the instant asked, not once for the year', () => {
    // The reason this takes a date at all: Berlin is +01:00 in winter and
    // +02:00 in summer, and printing one of them all year is a confident lie.
    expect(formatZone('Europe/Berlin', july).text).toBe('Europe/Berlin (UTC+02:00)');
    expect(formatZone('Europe/Berlin', january).text).toBe('Europe/Berlin (UTC+01:00)');
    expect(formatZone('America/New_York', july).text).toBe('America/New_York (UTC-04:00)');
  });

  it('handles a half-hour offset', () => {
    expect(formatZone('Asia/Kolkata', july).text).toBe('Asia/Kolkata (UTC+05:30)');
  });

  it('says UTC plainly, without an offset nobody needs', () => {
    expect(formatZone('UTC', july)).toEqual({ text: 'UTC', valid: true });
  });

  it('reports an unresolvable zone rather than pretending it is UTC', () => {
    // The worker does not fall back either: cron-parser throws on this zone and
    // the sweep disables the schedule. The screen has to be able to say so.
    expect(formatZone('Mars/Phobos', july)).toEqual({ text: 'Mars/Phobos', valid: false });
    expect(formatZone('', july).valid).toBe(false);
  });
});

describe('describeStreak', () => {
  it('states the whole state of a monitor in one line', () => {
    expect(describeStreak({ consecutiveFailures: 0, failureThreshold: 5, enabled: true })).toBe(
      'passing · alerts after 5 in a row',
    );
    expect(describeStreak({ consecutiveFailures: 3, failureThreshold: 5, enabled: true })).toBe(
      '3 consecutive failures · alerts at 5',
    );
    expect(describeStreak({ consecutiveFailures: 1, failureThreshold: 2, enabled: true })).toBe(
      '1 consecutive failure · alerts at 2',
    );
  });

  it('switches tense once the threshold has been crossed', () => {
    // Past the threshold the alert has already gone out; saying "alerts at 5"
    // while sitting on six failures reads as though it is still waiting.
    expect(describeStreak({ consecutiveFailures: 6, failureThreshold: 5, enabled: true })).toBe(
      '6 consecutive failures · alerted at 5',
    );
  });

  it('says a paused monitor is not checking, whatever its streak was', () => {
    expect(describeStreak({ consecutiveFailures: 4, failureThreshold: 5, enabled: false })).toBe(
      'paused — not checking',
    );
  });
});

describe('shortUntil', () => {
  const now = Date.parse('2026-08-24T12:00:00Z');
  const inMs = (ms: number) => new Date(now + ms).toISOString();

  it('counts down in the unit that fits, rounded down', () => {
    expect(shortUntil(inMs(30_000), now)).toBe('in <1m');
    expect(shortUntil(inMs(90_000), now)).toBe('in 1m');
    expect(shortUntil(inMs(59 * 60_000), now)).toBe('in 59m');
    expect(shortUntil(inMs(3 * 3_600_000 + 59 * 60_000), now)).toBe('in 3h');
    expect(shortUntil(inMs(72 * 3_600_000), now)).toBe('in 3d');
  });

  it('says a fire time in the past is due rather than negative', () => {
    // Normal, not exceptional: the sweep runs on an interval, so a schedule is
    // briefly overdue every single time it fires.
    expect(shortUntil(inMs(-1000), now)).toBe('due now');
    expect(shortUntil(inMs(-7 * 24 * 3_600_000), now)).toBe('due now');
  });

  it('returns nothing at all for a timestamp it cannot read', () => {
    expect(shortUntil('not a date', now)).toBe('');
  });
});

describe('timeInZone', () => {
  // 02:00 UTC on a Tuesday — three different local clocks, one instant.
  const instant = '2026-08-25T02:00:00.000Z';

  it('reads the clock in the zone the schedule fires in, not the reader\'s', () => {
    expect(timeInZone(instant, 'UTC')).toBe('Tue, 2:00 AM');
    expect(timeInZone(instant, 'Europe/Berlin')).toBe('Tue, 4:00 AM');
    // Still Monday evening in Los Angeles: the weekday itself changes, which is
    // exactly why this is not rendered in the browser's zone.
    expect(timeInZone(instant, 'America/Los_Angeles')).toBe('Mon, 7:00 PM');
  });

  it('falls back to UTC for a zone that does not resolve', () => {
    expect(timeInZone(instant, 'Mars/Phobos')).toBe('Tue, 2:00 AM');
  });

  it('returns nothing for a timestamp it cannot read', () => {
    expect(timeInZone('', 'UTC')).toBe('');
  });
});

describe('a step that does not divide its field', () => {
  /*
   * Cron restarts a step at the top of the field, so `a star-slash-N step` only repeats every
   * N when N divides the range. These are the cases that used to produce a
   * confident sentence describing a cadence the schedule does not have.
   */
  it.each([
    ['*/7 * * * *', 'minutes: 0,7,…,56 then 0 — a 4-minute gap'],
    ['*/8 * * * *', 'minutes: 0,8,…,56 then 0 — a 4-minute gap'],
    ['*/50 * * * *', 'minutes: 0,50 then 0 — a 10-minute gap'],
    ['0 */7 * * *', 'hours: 0,7,14,21 then 0 — a 3-hour gap'],
    ['0 */5 * * *', 'hours: 0,5,10,15,20 then 0 — a 4-hour gap'],
  ])('shows %s as an expression, because %s', (cron) => {
    expect(describeCron(cron).kind).toBe('expression');
  });

  it.each([
    ['*/5 * * * *', 'every 5 minutes'],
    ['*/15 * * * *', 'every 15 minutes'],
    ['*/30 * * * *', 'every 30 minutes'],
    ['0 */6 * * *', 'every 6 hours, on the hour'],
    ['0 */12 * * *', 'every 12 hours, on the hour'],
  ])('still describes %s, which divides evenly', (cron, text) => {
    expect(describeCron(cron)).toEqual({ kind: 'words', text });
  });
});
