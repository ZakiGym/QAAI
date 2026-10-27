/**
 * Coverage rollups — the arithmetic that lets one percentage be assigned to
 * somebody.
 *
 * WHY THIS FILE EXISTS
 *
 * The product can say "61% navigated" about a project and nothing else. Gaps
 * carry a `feature` string (`CoverageGap.feature`, set by `featureOf` in
 * coverage.ts) and ownership exists as `OwnershipRule` rows, and the two have
 * never met the denominator: `totalsForItems` produces global totals, so
 * "Payments is at 31%, owned by Team Billing" is unsayable. A single global
 * percentage is a number nobody is accountable for, which is a number nobody
 * acts on — it gets quoted in a slide and never turned into work.
 *
 * ── THE TWO RULES THAT MAKE A BREAKDOWN HONEST ──────────────────────────────
 *
 * 1. A BUCKET'S PERCENTAGE IS COMPUTED FROM ITS OWN NUMERATOR AND ITS OWN
 *    DENOMINATOR. Never by apportioning a global figure, and never by averaging
 *    the buckets to make a parent. Both shortcuts are arithmetically wrong and
 *    both are wrong in the direction nobody checks: one feature at 1/1 and one
 *    at 0/3 average to 50% and pool to 25%, and the 50% is the number a team
 *    would have been shown. {@link rollupCoverage} is therefore structurally
 *    incapable of it — it holds the ITEMS, filters them per bucket, and counts.
 *    No function in this file takes two rows and returns a percentage.
 *
 * 2. UNOWNED SURFACE IS A FINDING. "31% of the surface has no owner" is the
 *    most useful sentence this module can produce, so unattributed items get a
 *    NAMED bucket — `UNATTRIBUTED` and `UNOWNED`, spelled exactly as
 *    `apps/api/src/routes/issues.ts` and the keystone spell them — rather than
 *    being distributed among the teams that do own things (which fabricates
 *    debt for them) or dropped (which makes the finding disappear and raises
 *    every remaining bucket).
 *
 * ── ONE CALL IS ONE DENOMINATOR ─────────────────────────────────────────────
 *
 * `rollupCoverage` takes a `dimension` and REFUSES any item that does not carry
 * exactly that dimension. That is the whole defence against this product's
 * oldest defect: the headline percentage once summed routes + journeys + forms
 * + controls into one fraction, which made controls roughly 80% of the figure.
 * A caller who wants a PAGE_STATE rollup and a FORM_FIELD rollup makes two
 * calls and gets two denominators, in the open. There is no argument that lets
 * one call mix them.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 *
 * It reads nothing. No Prisma, no clock, no network, no model. Attribution is
 * an INPUT — `feature` and `teamId` on each item, resolved by whoever owns
 * `apps/api/src/lib/ownership.ts`'s precedence rules — because a rollup that
 * resolved ownership itself would be a second opinion about who owns a file,
 * and the first thing a second opinion does is diverge.
 */

import {
  DIMENSION_UNMEASURED_REASONS,
  DIMENSION_UNMEASURED_REASON_LABELS,
  UNATTRIBUTED_FEATURE,
  UNOWNED_TEAM,
  coveragePercent,
  rollupScopeKey,
  tierAtLeast,
} from '@qaai/shared';
import type {
  CoverageDimensionKind,
  CoverageTier,
  DimensionCapBite,
  DimensionUnmeasuredReason,
} from '@qaai/shared';

// ─── Caps, every one of which is disclosed when it bites ────────────────────

/**
 * The most rollup rows one call will emit.
 *
 * A project with 80 features and 12 teams produces 80 + 12 + up to 960 pairs,
 * and the pair rows are the ones that explode. The cap is here rather than at
 * the caller because the caller is the HTTP handler and a cap applied in a
 * handler is a cap nobody records — rule 10 requires it as a count AND a
 * reason, and {@link RollupReconciliation.rowsDropped} plus a
 * {@link DimensionCapBite} are where both land.
 *
 * The headline row is NEVER dropped by it. It is "every rollup table's one
 * unavoidable row" and a response that omitted it would leave a reader to
 * reconstruct the whole by adding buckets — which is the arithmetic this file
 * exists to stop them having to do.
 */
export const MAX_ROLLUP_ROWS = 500;

/**
 * The most exclusion sentences one row carries, matching
 * `coverageRollupSchema`'s `.max(50)` so a row this module builds is always
 * storable. A row whose exclusions were truncated says so through a cap bite,
 * because "which items were excluded and why" silently cut off at 50 is the
 * same omission as not writing it at all.
 */
export const MAX_ROLLUP_EXCLUSIONS = 50;

/** Matching `coverageRollupSchema`'s `.max(20)` on `caps`, for the same reason. */
export const MAX_ROLLUP_CAPS = 20;

// ─── What goes in ───────────────────────────────────────────────────────────

/**
 * Why one item is not in a bucket's denominator.
 *
 * The SAME closed vocabulary the dimension measurements use
 * (`DIMENSION_UNMEASURED_REASONS`), deliberately not a second one. A rollup is
 * the surface a reader is most likely to quote, so the explanation it prints
 * must be the explanation the per-dimension screen prints — a buyer who reads
 * one and then the other must not find two accounts of the same shortfall.
 *
 * `detail` is required and refused when empty: a reason code with no sentence
 * is a disclosure only somebody holding this repository can read.
 */
export interface RollupExclusion {
  reason: DimensionUnmeasuredReason;
  detail: string;
}

/**
 * One cell, with its tier and its attribution.
 *
 * ── `feature` AND `teamId` ARE NULLABLE WITH NO DEFAULT ────────────────────
 *
 * Null means NOBODY ATTRIBUTED IT, and it is bucketed under
 * {@link UNATTRIBUTED_FEATURE} / {@link UNOWNED_TEAM} rather than guessed at.
 * There is no default owner anywhere in this codebase on purpose — the note on
 * `model OwnershipRule` says it: inventing one would page whoever happened to
 * be listed first, and the second time that happens the feature gets switched
 * off. The same logic applies to a number: attributing unowned surface to the
 * largest team would hand them debt they did not incur.
 *
 * ── `tier: null` IS NOT `excluded` ─────────────────────────────────────────
 *
 * `tier: null` is a MEASURED cell that nothing claims — the gap this product
 * exists to shrink — and it stays in the denominator. `excluded` is a cell that
 * left the denominator, with a reason. Merging them would let the number rise
 * every time our own measurement got worse, which is the property
 * `SurfaceStatus.UNKNOWN` exists to deny.
 */
export interface RollupItem {
  /**
   * The cell's identity, as `dimensionCellIdentity` spells it (or the item key
   * for an axis-level rollup). Used for the duplicate refusal and for the
   * exclusion sentences, so it must be the stored key and not a label.
   */
  key: string;
  /**
   * Which denominator this cell belongs to. MUST equal the scope's dimension —
   * see the header. Null for an axis-level rollup over `CoverageItem`s
   * themselves rather than over the cells beneath them.
   */
  dimension: CoverageDimensionKind | null;
  /** The rung this cell reached. Null is measured and unclaimed. */
  tier: CoverageTier | null;
  /** The feature, or null for "nobody attributed it". */
  feature: string | null;
  /** The owning team's id, or null for "nobody owns it". */
  teamId: string | null;
  /** Non-null when the cell left the denominator. */
  excluded: RollupExclusion | null;
}

export interface RollupInput {
  /** The one denominator this call is about. */
  dimension: CoverageDimensionKind | null;
  /**
   * The rung every row is measured at. REQUIRED, with no default: a rollup that
   * does not say which bar it cleared is comparable to no other rollup, and two
   * rows silently taken at NAVIGATED and PASSING look identical on screen.
   */
  tier: CoverageTier;
  items: readonly RollupItem[];
  /**
   * Caps that bit BEFORE this call — a crawl budget, an extractor's take limit.
   * Carried onto every row rather than dropped, because the truncation that
   * shrank the denominator is a fact about the figure the row prints.
   */
  caps?: readonly DimensionCapBite[];
}

// ─── What comes out ─────────────────────────────────────────────────────────

/**
 * One stored rollup row, in `coverageRollupSchema`'s shape.
 *
 * `scopeKey` is built by the shared {@link rollupScopeKey} and never spelled
 * here, so the key this module writes and the key the API's refinement
 * recomputes cannot disagree — the schema refuses the row if they do, and that
 * refusal is the guard, not this comment.
 */
export interface CoverageRollupRow {
  scopeKey: string;
  dimension: CoverageDimensionKind | null;
  feature: string | null;
  teamId: string | null;
  numerator: number;
  denominator: number;
  /** `numerator / denominator`, one decimal, NULL when the denominator is zero. */
  percent: number | null;
  tier: CoverageTier;
  /** Cells in this bucket that left its denominator. Counted, never dropped. */
  unmeasured: number;
  /** The dominant reason, by cell count. See {@link dominantRollupReason}. */
  unmeasuredReason: DimensionUnmeasuredReason | null;
  /** The sentence, naming EVERY reason group and its count. */
  unmeasuredDetail: string | null;
  caps: DimensionCapBite[];
  /** Which items were excluded and why, as sentences. */
  exclusions: string[];
}

/**
 * THE FINDING THIS MODULE EXISTS FOR.
 *
 * Both shares are taken over the HEADLINE DENOMINATOR — the cells actually in
 * scope — so they are directly comparable to the coverage percentage beside
 * them. Taking them over every row including the excluded ones would produce a
 * share of a different population than the figure it sits next to, which is
 * two denominators in one sentence.
 */
export interface AttributionFinding {
  /** The headline denominator these are a share of. */
  surface: number;
  /** Cells no feature could be attributed to. */
  unattributedFeature: number;
  /** Cells nobody owns. */
  unownedTeam: number;
  /** Null when nothing was in scope. Never 0 and never 100 for an empty scope. */
  unattributedPercent: number | null;
  unownedPercent: number | null;
  /**
   * Attribution values that are spelled exactly like the sentinels.
   *
   * A customer feature genuinely called `UNATTRIBUTED`, or a team whose id is
   * `UNOWNED`, shares a bucket with the surface nobody attributed — the one
   * bucket whose whole value is that it is a finding. The counts above are
   * taken from `feature === null` / `teamId === null` directly, so they stay
   * true; what is affected is the bucket ROW, and a reader has to be told
   * rather than left to wonder why Payments' row is larger than Payments.
   */
  collidedWithSentinel: string[];
  /** The sentence a reader forwards. */
  sentence: string;
}

/**
 * WHETHER THE PARTS ADD BACK TO THE WHOLE.
 *
 * A rollup whose parts do not reconstruct the whole must say which items were
 * excluded and why — otherwise the only way to notice is to add the buckets up
 * by hand and find they fall short, and nobody does that until a customer does
 * it first.
 *
 * Both partitions are summed from EVERY bucket, before {@link MAX_ROLLUP_ROWS}
 * drops any, so `reconciles` is a statement about the arithmetic and not about
 * what survived a page size. The rows the cap dropped are reported separately,
 * because "the maths is wrong" and "we only showed you the biggest 500" are
 * different sentences with different remedies.
 */
export interface RollupReconciliation {
  /** The headline's denominator. */
  whole: number;
  /** The sum of every per-feature bucket's denominator. */
  featurePartsSum: number;
  /** The sum of every per-team bucket's denominator. */
  teamPartsSum: number;
  /** True when both partitions add back to `whole`. */
  reconciles: boolean;
  /** Cells that left every denominator. */
  excluded: number;
  /** Why they left, as sentences. Capped and disclosed like every other list. */
  exclusions: string[];
  /** Buckets {@link MAX_ROLLUP_ROWS} dropped. The headline is never one of them. */
  rowsDropped: number;
  /** One sentence covering all four facts above. */
  detail: string;
}

export interface CoverageRollupResult {
  /** Headline first, then the buckets, biggest denominator first. */
  rows: CoverageRollupRow[];
  /** The headline row. Also the first entry of {@link rows}. */
  headline: CoverageRollupRow;
  attribution: AttributionFinding;
  reconciliation: RollupReconciliation;
}

// ─── Why cells are unmeasured, when several reasons apply at once ───────────

/**
 * The reason to PRINT when a bucket's unmeasured cells have several, chosen by
 * PLURALITY and never by a precedence table of my own.
 *
 * `DimensionMeasurement` carries exactly one `unmeasuredReason` and a bucket
 * can easily have two — three cells waived by the team and twelve lost to a
 * page budget. Something has to choose. A hand-written precedence would be this
 * module's opinion about which of our limits matters most, applied to a
 * customer's data, and the group it demoted would be invisible. So the
 * DOMINANT group wins and {@link unmeasuredSentence} names every group with its
 * count, which means no group can be hidden by the choice.
 *
 * Ties break by position in `DIMENSION_UNMEASURED_REASONS` — the keystone's own
 * declaration order, imported rather than restated, so a sixth reason lands
 * where whoever declared it put it instead of where this file guessed.
 *
 * Returns null for an empty map, which is a bucket with nothing unmeasured.
 *
 * ── A DUPLICATE THAT EXISTS AND IS NAMED RATHER THAN HIDDEN ────────────────
 *
 * `coverage-matrix.ts` landed `dominantUnmeasuredReason` in this same round:
 * same input, same plurality rule, same declaration-order tie-break, same
 * `count — label` detail format, and a richer return (it carries the total as
 * well). Two implementations of one disclosure is two spellings of the same
 * sentence waiting to diverge, and a star export of both from the package
 * barrel is TS2308 on that file.
 *
 * This one is renamed rather than left to collide, so the barrel is not blocked
 * by a name — not because two are wanted. ONE of the two should survive, and
 * the consolidation is reported in this round's needsFromOtherFiles rather than
 * done by reaching into a file this slice does not own.
 */
export function dominantRollupReason(
  counts: ReadonlyMap<DimensionUnmeasuredReason, number>,
): DimensionUnmeasuredReason | null {
  let best: DimensionUnmeasuredReason | null = null;
  let bestCount = 0;
  for (const reason of DIMENSION_UNMEASURED_REASONS) {
    const count = counts.get(reason) ?? 0;
    if (count === 0) continue;
    // Strictly greater, so the earlier declaration wins a tie.
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The sentence beside the count, naming EVERY group.
 *
 * Groups are emitted in `DIMENSION_UNMEASURED_REASONS` order rather than by
 * size, so two buckets' sentences are diffable against each other. Labels come
 * from the keystone's `DIMENSION_UNMEASURED_REASON_LABELS`, so the explanation
 * on this screen is the explanation on every other one.
 */
export function unmeasuredSentence(
  counts: ReadonlyMap<DimensionUnmeasuredReason, number>,
): string | null {
  const parts: string[] = [];
  for (const reason of DIMENSION_UNMEASURED_REASONS) {
    const count = counts.get(reason) ?? 0;
    if (count === 0) continue;
    parts.push(`${count} — ${DIMENSION_UNMEASURED_REASON_LABELS[reason]}`);
  }
  if (parts.length === 0) return null;
  return `not scored: ${parts.join('; ')}`;
}

// ─── Caps: merged so that neither side's disclosure is lost ─────────────────

/**
 * Combines the caps this module recorded with the caps it was handed, keeping
 * the total inside {@link MAX_ROLLUP_CAPS}.
 *
 * MINE GO FIRST, because they are facts about THIS row that nothing else in the
 * system records, whereas an upstream bite is also recorded upstream. If the
 * limit then forces anything out, the last slot is spent saying how many were
 * dropped — a truncated disclosure list that does not mention its own
 * truncation is the exact defect rule 10 names, one level up from the caps it
 * is holding.
 */
function mergeCaps(
  mine: readonly DimensionCapBite[],
  theirs: readonly DimensionCapBite[],
): DimensionCapBite[] {
  const all = [...mine, ...theirs];
  if (all.length <= MAX_ROLLUP_CAPS) return all;
  const kept = all.slice(0, MAX_ROLLUP_CAPS - 1);
  const dropped = all.length - kept.length;
  kept.push({
    cap: 'rollupCaps',
    limit: MAX_ROLLUP_CAPS,
    atLeastMore: dropped,
    detail:
      `${dropped} further cap bite(s) were recorded for this bucket and are not carried on ` +
      `this row; a row holds at most ${MAX_ROLLUP_CAPS}`,
  });
  return kept;
}

// ─── The one row builder ────────────────────────────────────────────────────

/**
 * Builds one bucket's row from ITS OWN items.
 *
 * Every number on the row is counted from `items` here. There is no path by
 * which a bucket's figure is derived from another bucket's, which is what makes
 * rule 1 of the header structural rather than a convention somebody has to
 * remember.
 */
function buildRow(
  scope: { dimension: CoverageDimensionKind | null; feature: string | null; teamId: string | null },
  items: readonly RollupItem[],
  tier: CoverageTier,
  upstreamCaps: readonly DimensionCapBite[],
): CoverageRollupRow {
  const counted = items.filter((item) => item.excluded === null);
  const denominator = counted.length;
  const numerator = counted.filter((item) => tierAtLeast(item.tier, tier)).length;

  const reasonCounts = new Map<DimensionUnmeasuredReason, number>();
  const sentences: string[] = [];
  let sentencesDropped = 0;
  for (const item of items) {
    const excluded = item.excluded;
    if (excluded === null) continue;
    reasonCounts.set(excluded.reason, (reasonCounts.get(excluded.reason) ?? 0) + 1);
    if (sentences.length < MAX_ROLLUP_EXCLUSIONS) {
      sentences.push(`${item.key}: ${excluded.detail}`);
    } else {
      sentencesDropped += 1;
    }
  }

  const mine: DimensionCapBite[] = [];
  if (sentencesDropped > 0) {
    mine.push({
      cap: 'rollupExclusions',
      limit: MAX_ROLLUP_EXCLUSIONS,
      atLeastMore: sentencesDropped,
      detail:
        `${sentencesDropped} further excluded cell(s) are counted in \`unmeasured\` and their ` +
        `sentences are not listed; a row lists at most ${MAX_ROLLUP_EXCLUSIONS}`,
    });
  }

  return {
    scopeKey: rollupScopeKey(scope),
    dimension: scope.dimension,
    feature: scope.feature,
    teamId: scope.teamId,
    numerator,
    denominator,
    percent: coveragePercent(numerator, denominator),
    tier,
    unmeasured: items.length - denominator,
    unmeasuredReason: dominantRollupReason(reasonCounts),
    unmeasuredDetail: unmeasuredSentence(reasonCounts),
    caps: mergeCaps(mine, upstreamCaps),
    exclusions: sentences,
  };
}

/** The bucket an item's feature falls in. Null becomes the NAMED bucket. */
function featureBucket(item: RollupItem): string {
  return item.feature ?? UNATTRIBUTED_FEATURE;
}

/** The bucket an item's team falls in. Null becomes the NAMED bucket. */
function teamBucket(item: RollupItem): string {
  return item.teamId ?? UNOWNED_TEAM;
}

/** Groups items by a key, preserving first-seen order so output is stable. */
function groupBy(
  items: readonly RollupItem[],
  keyOf: (item: RollupItem) => string,
): Map<string, RollupItem[]> {
  const groups = new Map<string, RollupItem[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }
  return groups;
}

// ─── The entry point ────────────────────────────────────────────────────────

/**
 * Every rollup row for one denominator: the headline, each feature, each team,
 * and each (feature, team) pair that actually occurs.
 *
 * ── PAIRS ARE THE OBSERVED ONES, NOT THE CROSS PRODUCT ─────────────────────
 *
 * 80 features × 12 teams is 960 pair rows asserting that every team works on
 * every feature, which no source has declared. Only pairs that an item actually
 * has are emitted, which is the same judgement `dimensionDenominator` makes
 * about route × role cells and for the same reason: multiplying is dividing by
 * a number we made up.
 *
 * ── THE THREE REFUSALS ─────────────────────────────────────────────────────
 *
 * Throws, rather than skipping, on each of these. A skipped item is an item
 * missing from a denominator with nothing on screen to say so, and a rollup is
 * read as exhaustive by everyone who sees one.
 *
 *   1. AN ITEM FROM ANOTHER DIMENSION. Two denominators added together to make
 *      one percentage is the lie this product has already been burned by.
 *   2. A DUPLICATE KEY. One cell counted twice is one cell inflating both the
 *      numerator and the denominator, and it survives every eyeball check
 *      because the percentage still looks plausible.
 *   3. AN EXCLUSION WITH NO SENTENCE. "Excluded by policy" with no rule named
 *      is indistinguishable from a bug in our own extractor.
 */
export function rollupCoverage(input: RollupInput): CoverageRollupResult {
  const upstreamCaps = input.caps ?? [];
  const seen = new Set<string>();
  for (const item of input.items) {
    if (item.dimension !== input.dimension) {
      throw new Error(
        `rollup for ${input.dimension ?? 'the item axis'} was handed a ${
          item.dimension ?? 'item-axis'
        } cell (${item.key}) — two denominators in one percentage`,
      );
    }
    if (seen.has(item.key)) {
      throw new Error(`${item.key} appears twice in one rollup — that is one cell counted twice`);
    }
    seen.add(item.key);
    if (item.excluded !== null && item.excluded.detail.length === 0) {
      throw new Error(
        `${item.key} left the denominator with no sentence explaining it — a reason code alone ` +
          'is not something a customer can act on',
      );
    }
  }

  const scopeOf = (
    feature: string | null,
    teamId: string | null,
  ): {
    dimension: CoverageDimensionKind | null;
    feature: string | null;
    teamId: string | null;
  } => ({
    dimension: input.dimension,
    feature,
    teamId,
  });

  const featureRows: CoverageRollupRow[] = [];
  for (const [feature, items] of groupBy(input.items, featureBucket)) {
    featureRows.push(buildRow(scopeOf(feature, null), items, input.tier, upstreamCaps));
  }

  const teamRows: CoverageRollupRow[] = [];
  for (const [teamId, items] of groupBy(input.items, teamBucket)) {
    teamRows.push(buildRow(scopeOf(null, teamId), items, input.tier, upstreamCaps));
  }

  const pairRows: CoverageRollupRow[] = [];
  for (const [, items] of groupBy(
    input.items,
    (item) => `${featureBucket(item)}\u0000${teamBucket(item)}`,
  )) {
    const first = items[0];
    /* Unreachable — `groupBy` never creates an empty bucket — but
     * noUncheckedIndexedAccess makes the narrowing explicit rather than a `!`. */
    if (first === undefined) continue;
    pairRows.push(
      buildRow(scopeOf(featureBucket(first), teamBucket(first)), items, input.tier, upstreamCaps),
    );
  }

  /*
   * Summed from EVERY bucket, before the row cap. See the note on
   * `RollupReconciliation`: `reconciles` has to be a statement about the
   * arithmetic, not about what fitted in the response.
   */
  const featurePartsSum = featureRows.reduce((running, row) => running + row.denominator, 0);
  const teamPartsSum = teamRows.reduce((running, row) => running + row.denominator, 0);

  /*
   * Ranked by denominator so the buckets worth acting on survive the cap, then
   * by scopeKey so the order is total and the output is byte-stable across
   * runs. An unstable order would make two identical snapshots diff.
   */
  const ranked = [...featureRows, ...teamRows, ...pairRows].sort(
    (left, right) =>
      right.denominator - left.denominator || left.scopeKey.localeCompare(right.scopeKey),
  );
  const keep = ranked.slice(0, Math.max(0, MAX_ROLLUP_ROWS - 1));
  const rowsDropped = ranked.length - keep.length;

  /*
   * The headline is built LAST so the row cap's bite can be on it from the
   * start. Mutating a finished row to add a disclosure is how a disclosure
   * comes to be added on one code path and not another.
   */
  const headlineCaps: DimensionCapBite[] =
    rowsDropped > 0
      ? [
          {
            cap: 'rollupRows',
            limit: MAX_ROLLUP_ROWS,
            atLeastMore: rowsDropped,
            detail:
              `${rowsDropped} further bucket(s) exist and are not in this rollup; the ` +
              `${keep.length} with the largest denominators were kept, and the headline row is ` +
              'never dropped',
          },
          ...upstreamCaps,
        ]
      : [...upstreamCaps];
  const headline = buildRow(scopeOf(null, null), input.items, input.tier, headlineCaps);

  const countedItems = input.items.filter((item) => item.excluded === null);
  const unattributedFeature = countedItems.filter((item) => item.feature === null).length;
  const unownedTeam = countedItems.filter((item) => item.teamId === null).length;
  const surface = countedItems.length;
  const unattributedPercent = coveragePercent(unattributedFeature, surface);
  const unownedPercent = coveragePercent(unownedTeam, surface);

  const collidedWithSentinel = [
    ...new Set(
      input.items.flatMap((item) => {
        const hits: string[] = [];
        if (item.feature === UNATTRIBUTED_FEATURE) hits.push(`feature ${UNATTRIBUTED_FEATURE}`);
        if (item.teamId === UNOWNED_TEAM) hits.push(`team ${UNOWNED_TEAM}`);
        return hits;
      }),
    ),
  ];

  const collisionNote =
    collidedWithSentinel.length === 0
      ? ''
      : `; note that ${collidedWithSentinel.join(' and ')} is spelled exactly like the ` +
        'sentinel bucket, so that row mixes attributed surface with unattributed';

  /*
   * `unattributedPercent` and `unownedPercent` are non-null inside this branch
   * because `surface > 0`, and they are read through an explicit check rather
   * than `?? 0`: a `?? 0` here is a null that became a zero, which is the
   * shortest route in this file to printing "0% of the surface has no owner"
   * about a project nothing was measured for.
   */
  const shares =
    unownedPercent === null || unattributedPercent === null
      ? 'the shares could not be divided'
      : `${unownedPercent}% of the surface has no owner (${unownedTeam} of ${surface} cell(s)), ` +
        `and ${unattributedPercent}% could not be attributed to a feature ` +
        `(${unattributedFeature} of ${surface})`;

  const attribution: AttributionFinding = {
    surface,
    unattributedFeature,
    unownedTeam,
    unattributedPercent,
    unownedPercent,
    collidedWithSentinel,
    sentence:
      surface === 0
        ? 'nothing was in scope for this rollup, so there is no attribution to report — not 0% owned'
        : unattributedFeature === 0 && unownedTeam === 0
          ? `every one of the ${surface} cell(s) in scope carries a feature and an owning team` +
            collisionNote
          : shares + collisionNote,
  };

  const reconciles =
    featurePartsSum === headline.denominator && teamPartsSum === headline.denominator;
  const reconciliation: RollupReconciliation = {
    whole: headline.denominator,
    featurePartsSum,
    teamPartsSum,
    reconciles,
    excluded: headline.unmeasured,
    exclusions: headline.exclusions,
    rowsDropped,
    detail:
      (reconciles
        ? `the ${featureRows.length} feature bucket(s) and ${teamRows.length} team bucket(s) ` +
          `each add back to the headline's ${headline.denominator} cell(s)`
        : `THE PARTS DO NOT RECONSTRUCT THE WHOLE: the feature buckets hold ${featurePartsSum} ` +
          `and the team buckets ${teamPartsSum} against a headline of ${headline.denominator}`) +
      (headline.unmeasured > 0
        ? `; ${headline.unmeasured} cell(s) left every denominator — ${
            headline.unmeasuredDetail ?? 'no reason recorded'
          }`
        : '; nothing left the denominator') +
      (rowsDropped > 0 ? `; ${rowsDropped} bucket(s) were dropped by the row cap` : ''),
  };

  return { rows: [headline, ...keep], headline, attribution, reconciliation };
}
