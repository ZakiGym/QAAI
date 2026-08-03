'use client';

import Link from 'next/link';
import type { Run } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Skeleton } from '../ui/layout';
import { runElapsedMs, wallClock } from './format';

/**
 * The stats band — what /dashboard used to be.
 *
 * The old Dashboard and the old Runs page were the same data twice: a fleet
 * rollup twelve sidebar rows away from the run log it was rolling up. The
 * aggregates were worth keeping and the second screen was not, so they became
 * four cells across the top of the list they describe.
 *
 * Every number here is derived from the runs already in memory. That is a
 * deliberate constraint, not a shortcut: an aggregate that disagrees with the
 * list directly beneath it is worse than no aggregate, and deriving both from
 * one array makes disagreeing impossible.
 */

/** The window the rates are measured over, and the sentence that says so. */
const WINDOW_DAYS = 7;
/** The design's sparkline is 30 bars. More would be a chart, fewer a decoration. */
const SPARK_BARS = 30;

export interface StatsBandProps {
  runs: Run[];
  /** Verdicts a human has not ruled on yet — GET /verdicts?state=PENDING. */
  pendingVerdicts: number | null;
  /** Tests currently quarantined, from GET /projects/:id/flaky. */
  quarantined: number | null;
  loading: boolean;
  now: number;
}

export function StatsBand({ runs, pendingVerdicts, quarantined, loading, now }: StatsBandProps) {
  const since = now - WINDOW_DAYS * 86_400_000;
  const window = runs.filter((r) => new Date(r.queuedAt).getTime() >= since);

  const tests = window.reduce((sum, r) => sum + r.totalCount, 0);
  const passed = window.reduce((sum, r) => sum + r.passedCount, 0);
  const flaky = window.reduce((sum, r) => sum + r.flakyCount, 0);
  const passRate = tests > 0 ? (passed / tests) * 100 : null;
  const flakeRate = tests > 0 ? (flaky / tests) * 100 : null;

  /*
   * Mean and p95 over runs that actually finished. A run still in flight has no
   * duration yet, and counting it as its elapsed-so-far would drag the mean down
   * every four seconds while the poll refreshed.
   */
  const durations = window
    .map((r) => (r.finishedAt ? runElapsedMs(r, now) : null))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const meanMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const p95Ms =
    durations.length > 0
      ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]!
      : null;

  // Oldest to newest, left to right, so the bar row reads like a timeline.
  const spark = runs.slice(0, SPARK_BARS).reverse();

  return (
    <section
      aria-label={`Suite health over the last ${WINDOW_DAYS} days`}
      className="border-line mt-[30px] grid grid-cols-2 border-t border-b sm:grid-cols-[1.2fr_1fr_1fr_1fr]"
    >
      <Cell label={`PASS RATE · ${WINDOW_DAYS}D`} first>
        {loading ? (
          <StatSkeleton />
        ) : (
          <Stat value={passRate === null ? '—' : passRate.toFixed(1)} unit={rateUnit(passRate)} />
        )}
        {/* The rate is the claim; the sparkline is the evidence for it. A single
            percentage cannot tell you whether the suite is recovering or falling
            over, which is the only thing anybody wants to know from it. */}
        {!loading && spark.length > 0 && <Sparkline runs={spark} />}
      </Cell>

      <Cell label="AWAITING VERDICT">
        {loading || pendingVerdicts === null ? (
          <StatSkeleton />
        ) : (
          <Stat value={pendingVerdicts} tone="text-fail" />
        )}
        <p className="mt-3 text-[11.5px]">
          <Link href="/triage" className="text-accent hover:underline">
            open triage →
          </Link>
        </p>
      </Cell>

      <Cell label="FLAKE RATE">
        {loading ? (
          <StatSkeleton />
        ) : (
          <Stat value={flakeRate === null ? '—' : flakeRate.toFixed(1)} unit={rateUnit(flakeRate)} />
        )}
        <p className="text-ink-faint mt-3 text-[11.5px]">
          {/* The design's "radar at 20%" is a per-project policy this screen does
              not fetch, so it is not printed — a threshold shown as fact and
              wrong by ten points is worse than one not shown at all. */}
          {quarantined === null
            ? 'retries that passed, over the window'
            : quarantined === 0
              ? 'nothing quarantined'
              : `${quarantined} quarantined`}
        </p>
      </Cell>

      <Cell label="MEAN RUN">
        {loading ? <StatSkeleton /> : <Duration ms={meanMs} />}
        <p className="text-ink-faint mt-3 text-[11.5px] tabular-nums">
          {p95Ms === null ? 'no finished runs yet' : `p95 ${wallClock(p95Ms)}`}
        </p>
      </Cell>
    </section>
  );
}

function Cell({
  label,
  first = false,
  children,
}: {
  label: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'py-[18px]',
        // The first cell has no left rule and no left padding — it sits on the
        // page's own gutter, which is what keeps the band aligned with the title
        // above it rather than looking like an inset table.
        first ? 'pr-5' : 'border-line px-5 sm:border-l',
      )}
    >
      <p className="text-ink-faint text-meta font-mono tracking-[0.1em] uppercase">{label}</p>
      {children}
    </div>
  );
}

/**
 * A stat numeral, with its unit set smaller and dimmer.
 *
 * `96.2%` at one size reads as a five-character string; at two it reads as a
 * number that happens to be a percentage, which is the thing being reported.
 */
/**
 * The percent sign, or nothing.
 *
 * Written out rather than inlined as `rate && '%'`: a rate of 0 is falsy, so
 * that expression evaluates to the NUMBER zero, and React renders a zero — a
 * flake rate of 0.0% came out as "0.00" on a suite with no flakes at all.
 */
function rateUnit(rate: number | null): string | undefined {
  return rate === null ? undefined : '%';
}

function Stat({
  value,
  unit,
  tone,
}: {
  value: React.ReactNode;
  unit?: string;
  tone?: string;
}) {
  return (
    <p className={cn('font-display text-stat mt-1.5 leading-none font-semibold tabular-nums', tone)}>
      {value}
      {unit && <span className="text-ink-dim text-[17px]">{unit}</span>}
    </p>
  );
}

/** `4m 12s` split so the units drop back the same way a percent sign does. */
function Duration({ ms }: { ms: number | null }) {
  if (ms === null) return <Stat value="—" />;
  const text = wallClock(ms);
  const parts = text.match(/(\d+)([a-z]+)/g) ?? [text];
  return (
    <p className="font-display text-stat mt-1.5 leading-none font-semibold tabular-nums">
      {parts.map((part, i) => {
        const [, digits = part, unit = ''] = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(part) ?? [];
        return (
          <span key={i}>
            {i > 0 && ' '}
            {digits}
            <span className="text-ink-dim text-[17px]">{unit}</span>
          </span>
        );
      })}
    </p>
  );
}

function StatSkeleton() {
  return <Skeleton className="mt-2 h-[30px] w-20" />;
}

/**
 * Thirty runs, one bar each.
 *
 * Height is the pass ratio and colour is what went wrong, so a bar that is
 * short AND red is a bad run twice over — which is how a person reads a
 * sparkline anyway. Pass bars sit at 85% opacity so the exceptions come
 * forward: on a healthy suite this is a wall of green, and the point of the
 * strip is the three bars that are not.
 */
function Sparkline({ runs }: { runs: Run[] }) {
  return (
    <div
      className="mt-3 flex h-[22px] max-w-[220px] items-end gap-[2px]"
      role="img"
      aria-label={`Pass ratio of the last ${runs.length} runs, oldest first`}
    >
      {runs.map((run) => {
        const ratio = run.totalCount > 0 ? run.passedCount / run.totalCount : 0;
        const tone =
          run.failedCount > 0 || run.status === 'ERRORED'
            ? 'bg-fail'
            : run.flakyCount > 0
              ? 'bg-flake'
              : 'bg-pass opacity-85';
        return (
          <div
            key={run.id}
            title={`${run.id.slice(-8)} · ${run.passedCount}/${run.totalCount} passed`}
            // A zero-height bar is invisible, and an invisible bar reads as a
            // run that never happened rather than one where nothing passed.
            style={{ height: `${Math.max(ratio * 100, 6)}%` }}
            className={cn('flex-1 rounded-[1px]', tone)}
          />
        );
      })}
    </div>
  );
}
