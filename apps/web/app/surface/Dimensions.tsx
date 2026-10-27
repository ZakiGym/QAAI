'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, SectionLabel, SkeletonRows } from '../../components/ui/layout';
import { api, type CoverageDimensionReport, type StoredDimensionView } from '../../lib/api';

/**
 * The per-dimension breakdown, beneath the dark-surface figure.
 *
 * ── CORRECTNESS ONLY, AND THAT IS A CONSTRAINT RATHER THAN A SHORTCUT ───────
 *
 * No new visual language: `Badge`, `SectionLabel`, `SkeletonRows` and the
 * hairline-row idiom from `AccessAndDrift.tsx`, and nothing else. The owner is
 * designing this section later and asked for correctness-only UI work, so what
 * this file is FOR is the one distinction a redesign could not recover if it
 * were lost here:
 *
 *   AN UNMEASURED DIMENSION MUST BE VISUALLY DISTINCT FROM A 0% ONE.
 *
 * "0% of your component states are covered" is a lie about the customer's
 * application assembled out of our own silence. "We do not measure component
 * states" is a true and useful fact about our product. They are one `??` apart
 * in code and a whole conversation apart in meaning, so this file renders the
 * second as WORDS — the reason, in the customer's terms — and never as a
 * number. There is deliberately no expression below of the form
 * `percent ?? 0`, and `figureOf` is the only place a figure is produced.
 *
 * ── AND NO COMBINED FIGURE ─────────────────────────────────────────────────
 *
 * Thirteen axes, thirteen denominators, and `report.rule` printed where a total
 * would go. The previous headline summed four axes and made one of them 80% of
 * the quoted number; nine more axes is nine more chances, and a renderer that
 * added two of these together would be the easiest place in the product to do
 * it by accident.
 */

/** The rung every figure on this screen is taken at. Stated, never implied. */
const TIER = 'ASSERTED';

/**
 * ONE DIMENSION'S FIGURE, or the honest absence of one.
 *
 * The ONLY place a percentage is produced on this screen, and it returns a
 * STRING rather than a number so that no caller can arithmetic its way into a
 * second one. `wasMeasured` is the branch — not `percent !== null`, and not
 * `measured > 0` — because the API computes that predicate with
 * `dimensionWasMeasured` and a screen that re-derived it would be a second
 * opinion about whether we measured something.
 */
function figureOf(dimension: StoredDimensionView): string | null {
  if (!dimension.wasMeasured) return null;
  const rung = dimension.tiers.tiers.find((entry) => entry.tier === TIER);
  /*
   * NULL here is a real state and not a bug: the rung exists and its
   * denominator is zero, which `coveragePercent` answers with null. Printing
   * "0.0%" for it would be the same lie one level down.
   */
  if (!rung || rung.percent === null) return null;
  return `${rung.percent.toFixed(1)}%`;
}

/** The reason an axis has no figure, in the customer's terms. Always present. */
function absenceOf(dimension: StoredDimensionView): string {
  if (dimension.unmeasuredDetail) return dimension.unmeasuredDetail;
  if (dimension.unmeasuredReason) return dimension.unmeasuredReason;
  /*
   * A reading with no figure and no reason cannot be produced by either
   * constructor in packages/shared — both refuse it — so reaching this means a
   * hand-built payload got through. It says so rather than inventing a reason:
   * our guess in place of a disclosure is worse than the admission.
   */
  return 'This axis reports no figure and the writer recorded no reason, which is a defect in QAAI rather than a fact about your application.';
}

export interface DimensionsData {
  report: CoverageDimensionReport | null;
  loading: boolean;
  error: string | null;
}

export function useDimensions(projectId: string | null, projectSettling: boolean): DimensionsData {
  const [report, setReport] = useState<CoverageDimensionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (project: string) => {
    return api<CoverageDimensionReport>(`/coverage/${project}/dimensions`);
  }, []);

  useEffect(() => {
    if (projectSettling) return;
    if (!projectId) {
      setReport(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    load(projectId)
      .then((next) => {
        if (!live) return;
        setReport(next);
      })
      .catch((err: unknown) => {
        if (!live) return;
        /*
         * The error is SHOWN and the panel is not silently empty. "We could not
         * read the breakdown" and "this project has no breakdown" are the two
         * sentences this screen exists to keep apart, and a blank panel reads
         * as the second.
         */
        setReport(null);
        setError(err instanceof Error ? err.message : 'The dimension breakdown could not be read.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, projectSettling, load]);

  return { report, loading, error };
}

export function Dimensions({ data }: { data: DimensionsData }) {
  if (data.loading) return <SkeletonRows rows={5} />;

  if (data.error !== null) {
    return (
      <p className="text-ink-dim text-row-sub leading-relaxed">
        The per-dimension breakdown could not be read: {data.error} That is a failure of this
        request and not a measurement — read it as unknown, never as zero.
      </p>
    );
  }

  if (data.report === null) {
    return (
      <p className="text-ink-dim text-row-sub leading-relaxed">
        Nothing has been measured for this project yet, so there is no breakdown. This is not 0% on
        any axis.
      </p>
    );
  }

  const report = data.report;

  return (
    <div>
      <SectionLabel>Breakdown by dimension</SectionLabel>
      {/*
        THE RULE, PRINTED WHERE A TOTAL WOULD GO. Not a tooltip: a reader who
        looks for a combined figure has to find the reason there is none, and a
        reason behind a hover is a reason most readers never see.
      */}
      <p className="text-ink-dim text-row-sub leading-relaxed">{report.rule}</p>

      {/* The delta, with its comparability. Never a bare number. */}
      <p className="text-ink-dim text-row-sub mt-2.5 leading-relaxed">
        {report.delta === null
          ? 'No stored history for this project, so there is no change to report — not "no change".'
          : report.delta.meaningful
            ? report.delta.deltaPercent === null
              ? 'Comparable to the previous measurement, and one side has no percentage — its denominator was zero.'
              : `${report.delta.deltaPercent >= 0 ? '+' : ''}${report.delta.deltaPercent.toFixed(1)} points since the previous measurement.`
            : `No comparable baseline: ${report.delta.comparabilityDetail ?? 'the two snapshots are not comparable.'}`}
      </p>

      <div className="mt-3">
        {report.dimensions.map((dimension) => {
          const figure = figureOf(dimension);
          return (
            <div key={dimension.dimension} className="border-line border-b py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-row font-mono">{dimension.dimension}</span>
                {/*
                  THE BRANCH THIS WHOLE FILE EXISTS FOR. A measured axis gets its
                  figure in an accent chip; an unmeasured one gets the WORDS "not
                  measured" in a neutral chip. Two different chips and two
                  different strings, so the states cannot be confused by a reader
                  glancing at the column — which is exactly what a 0.0% in the
                  same position would invite.
                */}
                {figure === null ? (
                  <Badge tone="neutral">not measured</Badge>
                ) : (
                  <Badge tone="accent">
                    {figure} of {dimension.measured}
                  </Badge>
                )}
              </div>
              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
                {figure === null ? (
                  absenceOf(dimension)
                ) : (
                  <>
                    {dimension.measured} of {dimension.cells} cell(s) measured at {TIER}.
                    {dimension.unmeasured > 0 && ` ${dimension.unmeasured} not measured: ${absenceOf(dimension)}`}
                  </>
                )}
              </p>
              {/*
                EVERY CAP THAT BIT, as a count AND a reason. A truncated
                denominator presented as a whole application is the defect rule
                10 of this codebase names, and this is its door onto the screen.
              */}
              {dimension.caps.map((cap) => (
                <p key={cap.cap} className="text-ink-faint text-row-sub mt-1 leading-relaxed">
                  {cap.cap} capped at {cap.limit}:{' '}
                  {cap.atLeastMore === null
                    ? 'an unknown number more existed'
                    : `at least ${cap.atLeastMore} more existed`}
                  . {cap.detail}
                </p>
              ))}
            </div>
          );
        })}
      </div>

      {/*
        `storedCells: null` is "this deployment cannot answer" and must never
        render as "no cells exist" — an empty breakdown reads as a project whose
        detail is genuinely absent, which is the opposite of the truth.
      */}
      {report.storedCells === null && (
        <p className="text-ink-faint text-row-sub mt-3 leading-relaxed">
          The per-cell tables could not be read on this deployment, so the figures above come from
          this computation rather than from stored rows. Read that as unknown, never as empty.
        </p>
      )}
      <p className="text-ink-faint text-row-sub mt-3 leading-relaxed">{report.why}</p>
    </div>
  );
}
