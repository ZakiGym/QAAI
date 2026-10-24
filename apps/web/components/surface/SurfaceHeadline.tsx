'use client';

import { SURFACE_KIND_LABELS } from '@qaai/shared';
import { SectionLabel } from '../ui/layout';
import {
  describeKind,
  describeUnmeasured,
  formatPercent,
  gapCount,
  headlineFor,
  otherStates,
  reconciliation,
  sparkline,
  storedDrift,
  type StoredSnapshot,
  type SurfaceReport,
} from '../../lib/surface';

/**
 * The answer, before the list.
 *
 * One number, the caveats that qualify it, and then the counts the reader will
 * otherwise assume are gaps. Everything here is a sentence rather than a tile
 * because the number on its own is the part people argue with — a bare 62.4%
 * invites "measured against what?", and this block answers that before anyone
 * has to ask.
 *
 * Nothing in this file decides anything. The rules about null percentages,
 * unmeasured axes and the three not-a-gap states are enforced in
 * lib/surface.ts, where they are covered by tests; this only places them.
 */

export function SurfaceHeadline({
  report,
  trend,
}: {
  report: SurfaceReport;
  /** Stored snapshots, newest first. Empty until a recompute has been stored. */
  trend: StoredSnapshot[];
}) {
  const { snapshot } = report;
  const totals = snapshot.totals;
  const headline = headlineFor(totals);
  const drift = storedDrift(totals, report.lastStored);

  return (
    <section>
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-display leading-[1.2] font-semibold">
            {headline.sentence}
          </h2>
          {headline.measured ? (
            <p className="text-ink-dim text-body-sm mt-2">{headline.detail}</p>
          ) : (
            <>
              <p className="text-ink-dim text-body-sm mt-2 max-w-prose leading-relaxed">
                {headline.reason}
              </p>
              <p className="text-ink text-body-sm mt-1.5">{headline.next}</p>
            </>
          )}
        </div>
        <Trend trend={trend} />
      </div>

      {/*
       * The gap count, which is what the list below is. Stated here as its own
       * number so the reader can see that it is UNCOVERED alone — the three
       * counts in the strip further down are NOT in it.
       */}
      <p className="text-ink-dim text-body-sm mt-3">
        <span className="text-ink tabular-nums">{gapCount(totals)}</span> item
        {gapCount(totals) === 1 ? '' : 's'} in your application have no test at all. They are named
        below, with the file each one is declared in.
      </p>

      {drift && (
        /*
         * The live number and the stored one are allowed to differ — a read
         * never writes a snapshot — but a CI gate acts on the stored one, so
         * somebody comparing this screen to a failing gate needs to be told
         * which number they are looking at.
         */
        <p className="text-ink-faint text-row-sub mt-2">
          A snapshot was last stored at {formatPercent(drift.stored.percent)} over{' '}
          <span className="tabular-nums">{drift.stored.denominator}</span> items. The figure above
          is computed now and has not been stored, so a CI gate is still comparing against the older
          one.
        </p>
      )}

      <Caveats caveats={snapshot.caveats} />
      <ByKind report={report} />
      <OtherStates report={report} />
      <Reconciliation report={report} />
      <Unmeasured report={report} />
    </section>
  );
}

// ─── Caveats ─────────────────────────────────────────────────────────────────

/**
 * What the number could not see, as readable text beside the number.
 *
 * Never a tooltip and never an icon. Every caveat the server emits is a fact
 * about how the figure was produced — the crawl stopped at 60 pages, a detector
 * was blocked, there is no source analysis at all — and a percentage whose
 * inputs are hidden behind a hover cannot be defended in a meeting. They are
 * all rendered, not the first three with the rest folded away, because the one
 * that matters is never reliably the first.
 */
function Caveats({ caveats }: { caveats: string[] }) {
  if (caveats.length === 0) return null;
  return (
    <div className="border-flake/40 mt-6 border-l-2 pl-4">
      <SectionLabel className="text-flake mb-1.5">Before you trust this number</SectionLabel>
      <ul className="text-ink-dim text-body-sm max-w-prose space-y-2 leading-relaxed">
        {caveats.map((caveat, index) => (
          <li key={index}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

// ─── Per axis ────────────────────────────────────────────────────────────────

/** The four measured axes, each as its own ratio. No bars — just the numbers. */
function ByKind({ report }: { report: SurfaceReport }) {
  const byKind = report.snapshot.totals.byKind;
  if (byKind.length === 0) return null;

  return (
    <div className="mt-6 flex flex-wrap gap-x-7 gap-y-2.5">
      {byKind.map((totals) => {
        const described = describeKind(totals);
        return (
          <div key={totals.kind}>
            <p className="text-meta text-ink-faint font-mono tracking-[0.08em] uppercase">
              {SURFACE_KIND_LABELS[totals.kind]}
            </p>
            <p className="text-body-sm mt-0.5">
              <span className={described.measured ? 'text-ink tabular-nums' : 'text-ink-faint'}>
                {described.text}
              </span>
              {described.measured && (
                <span className="text-ink-faint ml-1.5 tabular-nums">
                  ({totals.covered}/{totals.denominator})
                </span>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── The three states that are not gaps ──────────────────────────────────────

/**
 * Quiet, distinct, and never merged into the gap count.
 *
 * Each of these is a count the reader would otherwise assume was part of the
 * 31. "A test exists but has never run" is the one that gets conflated with
 * covered, and "cannot tell" is the one that gets conflated with a gap; both
 * conflations flatter somebody, so both get their own row and their own
 * sentence.
 */
function OtherStates({ report }: { report: SurfaceReport }) {
  return (
    <div className="mt-8">
      <SectionLabel>Counted as neither</SectionLabel>
      <dl className="divide-line divide-y">
        {otherStates(report.snapshot.totals).map((state) => (
          <div key={state.status} className="flex items-baseline gap-3 py-2.5">
            <dt className="text-row min-w-0 flex-1">
              <span className="text-ink tabular-nums">{state.count}</span>{' '}
              <span className="text-ink-dim">{state.label}</span>
            </dt>
            <dd className="text-ink-faint text-row-sub max-w-prose flex-[2] leading-relaxed">
              {state.note}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Source against crawl, both directions.
 *
 * The second number is about US, and saying so is the whole reason it is on
 * screen: an item a crawl reached that our source analysis never declared is
 * our extractor's error rate, and suppressing it would be hiding the one
 * number a customer could use to audit this feature.
 */
function Reconciliation({ report }: { report: SurfaceReport }) {
  const recon = reconciliation(report.snapshot.totals);
  return (
    <div className="mt-8">
      <SectionLabel>Source against crawl</SectionLabel>
      <div className="space-y-3">
        <p className="text-ink-dim text-body-sm max-w-prose leading-relaxed">
          <span className="text-ink tabular-nums">{recon.declaredNeverReached}</span> declared and
          never reached. {recon.declaredNote}
        </p>
        <p className="text-ink-dim text-body-sm max-w-prose leading-relaxed">
          <span className="text-ink tabular-nums">{recon.reachedNeverDeclared}</span> reached and
          never declared. {recon.reachedNote}
        </p>
      </div>
    </div>
  );
}

// ─── Unmeasured axes ─────────────────────────────────────────────────────────

/**
 * The axes we have no extractor for, named.
 *
 * Not an omission and not a zero. A customer comparing us against a vendor who
 * quietly measures only frontend routes is entitled to the list of dimensions
 * this percentage does not include.
 */
function Unmeasured({ report }: { report: SurfaceReport }) {
  const lines = describeUnmeasured(report.unmeasuredKinds);
  if (lines.length === 0) return null;
  return (
    <div className="mt-8">
      <SectionLabel>Not in this number at all</SectionLabel>
      <p className="text-ink-dim text-body-sm max-w-prose leading-relaxed">
        {lines.join(' ')} These axes have no extractor yet, so they are absent from the denominator
        rather than sitting in it as zeroes — a nought on an axis we do not look at would be a claim
        about your application made out of our own silence.
      </p>
    </div>
  );
}

// ─── The trend ───────────────────────────────────────────────────────────────

/**
 * Thirty stored snapshots, as one polyline. No chart library.
 *
 * The scale is the series' own range, so the two end values are printed beside
 * it — a line that climbs steeply from 61.8% to 62.4% would otherwise imply a
 * movement that did not happen.
 */
function Trend({ trend }: { trend: StoredSnapshot[] }) {
  const width = 108;
  const height = 24;
  const line = sparkline(trend, width, height);
  if (!line) return null;

  return (
    <div className="shrink-0 text-right">
      <p className="text-meta text-ink-faint font-mono tracking-[0.08em] uppercase">
        Last <span className="tabular-nums">{line.count}</span> stored
      </p>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1.5 overflow-visible"
        role="img"
        aria-label={`Trend across ${line.count} stored snapshots, from ${formatPercent(
          line.oldest,
        )} to ${formatPercent(line.newest)}`}
      >
        <polyline
          points={line.points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-accent"
        />
      </svg>
      <p className="text-ink-faint text-meta mt-1 font-mono tabular-nums">
        {formatPercent(line.oldest)} → {formatPercent(line.newest)}
      </p>
      {line.unmeasured > 0 && (
        <p className="text-ink-faint text-meta mt-0.5">
          <span className="tabular-nums">{line.unmeasured}</span> not plotted — nothing to divide
        </p>
      )}
    </div>
  );
}
