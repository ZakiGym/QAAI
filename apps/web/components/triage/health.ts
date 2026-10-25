import type { TriageCauseList } from '../../lib/api';

/**
 * The two honesty rules the triage health strip rests on, kept where a test can
 * reach them.
 *
 * Both are about a number that does not exist. The scorecard's rates are NULL
 * when nothing was reviewed, and the cause list is CAPPED — and in both cases
 * the plausible-looking render ("0%", or just the rows) is the dishonest one.
 */

/**
 * A rate, or the reason there isn't one.
 *
 * NEVER "0%" for a null. `overrideRatePercent` is null when nobody reviewed a
 * verdict of that kind, and "this verdict has never been overruled" is the
 * opposite claim from "nobody has ever checked it" — printed as 0% it reads as
 * a pass, which makes it the most expensive kind of wrong number on the screen.
 *
 * Rounded to whole percent, matching the sentence the server writes beside it
 * (`toFixed(0)`), so the table and the prose cannot disagree by a decimal.
 */
export function ratePercentLabel(pct: number | null): string {
  return pct === null ? 'unmeasured' : `${Math.round(pct)}%`;
}

/**
 * Whether a cause list may be hiding rows, in words.
 *
 * `GET /triage/signatures` takes a `limit` and returns `returned` beside it,
 * precisely so a reader is never surprised by a truncated list: `returned ===
 * limit` means THERE MAY BE MORE, which is a different statement from "that is
 * all of them". A roster that showed the rows and not the cap would be a cap
 * applied without being disclosed.
 *
 * Null when the list is complete — there is nothing to say and a permanent
 * caveat would train people to ignore it.
 */
export function capNote(list: Pick<TriageCauseList, 'returned' | 'limit'>): string | null {
  if (list.returned < list.limit) return null;
  return `Showing the first ${list.limit}. There may be more — this is the server's page limit, not the whole roster.`;
}

/**
 * The one-line scorecard, in a sentence that cannot be read as a pass.
 *
 * Three cases, because the arithmetic has three outcomes and only one of them
 * is a rate:
 *
 *   nothing minted   there is no scorecard to report, and saying "0% overruled"
 *                    about a project with no verdicts is a claim about a model
 *                    that has not spoken.
 *   nothing reviewed the model has produced verdicts and no human has checked
 *                    one. This is the dangerous case and it is worded the way
 *                    `triageAccuracy` words it: unmeasured, NOT good.
 *   reviewed         the rate, with the coverage beside it, because a project
 *                    that reviews three verdicts out of four hundred has a loud
 *                    rate on a thin sample.
 */
export function accuracyHeadline(
  totals: {
    minted: number;
    reviewed: number;
    overridden: number;
    overrideRatePercent: number | null;
  },
  windowDays: number,
): string {
  if (totals.minted === 0) {
    return `No verdict was reached in the last ${windowDays} days, so there is nothing to score.`;
  }
  if (totals.reviewed === 0) {
    return `${totals.minted} verdict${totals.minted === 1 ? '' : 's'} in ${windowDays} days, and nobody has reviewed one — accuracy is unmeasured, not good.`;
  }
  return `Humans overruled ${totals.overridden} of the ${totals.reviewed} verdict${
    totals.reviewed === 1 ? '' : 's'
  } they reviewed — ${ratePercentLabel(totals.overrideRatePercent)} over ${windowDays} days.`;
}
