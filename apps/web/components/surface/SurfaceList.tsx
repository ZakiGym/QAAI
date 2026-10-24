'use client';

import Link from 'next/link';
import {
  MEASURED_SURFACE_KINDS,
  SURFACE_KIND_LABELS,
  SURFACE_ORIGINS,
  SURFACE_ORIGIN_LABELS,
  SURFACE_STATUSES,
  SURFACE_STATUS_LABELS,
} from '@qaai/shared';
import type { SurfaceItemCoverage, SurfaceKind, SurfaceOrigin, SurfaceStatus } from '@qaai/shared';
import { cn } from '../../lib/cn';
import { Badge, SectionLabel } from '../ui/layout';
import { Button } from '../ui/Button';
import {
  describeKind,
  groupByKind,
  heldBack,
  pageOf,
  type SurfaceFilters,
  type SurfaceReport,
} from '../../lib/surface';

/**
 * THE LIST. This is the screen.
 *
 * A percentage gets argued about; a list of 43 named routes with the file each
 * one is declared in gets forwarded to someone who can act on it. No competitor
 * can produce these rows — their denominator comes from the same process as
 * their numerator, so a surface nothing has ever reached is not uncovered to
 * them, it is invisible — which is why the row carries the name, the kind, the
 * declaring file and the evidence sentence, and why it is given the space
 * rather than a card grid.
 *
 * Grouped by axis in the order the SERVER sent them. For the default filter
 * that IS the ranking: `rankUncovered` puts auth surfaces before endpoints
 * before routes before forms, and declared-but-never-reached first inside an
 * axis. Re-sorting here would give the product two definitions of "worst", and
 * the one on the screen would drift from the one the CLI gate prints.
 *
 * Worth knowing when reading the groups: the endpoint only applies that
 * ranking when the status filter is UNCOVERED alone (it serves `uncovered` for
 * that case and the raw `entries` otherwise), so a multi-state filter arrives
 * in inventory order — kind, then key — rather than worst-first. The grouping
 * is faithful either way; the ordering is only as good as what was sent.
 */

export function SurfaceList({
  report,
  filters,
  onFilters,
  onWaive,
  onWithdraw,
  withdrawing,
}: {
  report: SurfaceReport;
  filters: SurfaceFilters;
  onFilters: (next: SurfaceFilters) => void;
  onWaive: (entry: SurfaceItemCoverage) => void;
  onWithdraw: (entry: SurfaceItemCoverage) => void;
  /** The key a withdrawal is in flight for, so only that row shows it. */
  withdrawing: string | null;
}) {
  const groups = groupByKind(report.items);
  const back = heldBack(report);
  const { page, pages } = pageOf(report);

  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <SectionLabel className="mb-0">
          What nothing has tested · <span className="tabular-nums">{report.total}</span>
        </SectionLabel>
      </div>

      <Filters report={report} filters={filters} onFilters={onFilters} />

      {report.items.length === 0 ? (
        /*
         * An empty list on THIS screen reads as "nothing is untested", which is
         * the most damaging thing it could say by accident. So it never just
         * renders nothing — it says which of the two reasons applies, and a
         * page past the end of the result is a different sentence from a filter
         * that matched nothing.
         */
        <p className="text-ink-faint text-body-sm py-6 leading-relaxed">
          {report.offset > 0 && report.total > 0 ? (
            <>
              This page is past the end of the result. There are{' '}
              <span className="tabular-nums">{report.total}</span> matching items — go back a page.
            </>
          ) : (
            <>
              No item matches this filter. That is a statement about the filter, not about your
              application — clear it to see the other{' '}
              <span className="tabular-nums">{report.snapshot.totals.denominator}</span> items in
              the denominator.
            </>
          )}
        </p>
      ) : (
        <div className="mt-6 space-y-8">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="border-line mb-1 flex flex-wrap items-baseline gap-x-3 border-b pb-1.5">
                <h3 className="text-micro text-ink font-mono font-semibold tracking-[0.1em] uppercase">
                  {group.label}
                </h3>
                <span className="text-ink-faint text-meta tabular-nums">
                  {group.items.length} listed
                </span>
                <KindMeasure kind={group.kind} report={report} />
              </div>
              <div>
                {group.items.map((entry) => (
                  <SurfaceRow
                    key={entry.item.key}
                    entry={entry}
                    onWaive={() => onWaive(entry)}
                    onWithdraw={() => onWithdraw(entry)}
                    withdrawing={withdrawing === entry.item.key}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/*
       * Truncation is REPORTED, never silently applied. A list showing 50 of
       * 243 while saying nothing is the kind of quiet omission that makes the
       * whole number untrustworthy.
       */}
      {report.total > report.items.length && (
        <div className="border-line mt-6 flex flex-wrap items-center gap-3 border-t pt-4">
          <p className="text-ink-dim text-row-sub">
            Showing <span className="tabular-nums">{report.offset + 1}</span>–
            <span className="tabular-nums">{report.offset + report.items.length}</span> of{' '}
            <span className="tabular-nums">{report.total}</span>
            {back > 0 && (
              <>
                {' '}
                · <span className="tabular-nums">{back}</span> held back after this page
              </>
            )}{' '}
            · page <span className="tabular-nums">{page}</span> of{' '}
            <span className="tabular-nums">{pages}</span>
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              disabled={report.offset === 0}
              onClick={() =>
                onFilters({ ...filters, offset: Math.max(0, report.offset - report.limit) })
              }
            >
              Previous
            </Button>
            <Button
              size="sm"
              disabled={back === 0}
              onClick={() => onFilters({ ...filters, offset: report.offset + report.limit })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The axis's own ratio, in the group header. Never a bare zero — see describeKind. */
function KindMeasure({ kind, report }: { kind: SurfaceKind; report: SurfaceReport }) {
  const totals = report.snapshot.totals.byKind.find((entry) => entry.kind === kind);
  if (!totals) return null;
  const described = describeKind(totals);
  return (
    <span
      className={cn('text-meta ml-auto', described.measured ? 'text-ink-dim' : 'text-ink-faint')}
    >
      {described.text}
      {described.measured && (
        <span className="text-ink-faint ml-1.5 tabular-nums">
          ({totals.covered}/{totals.denominator})
        </span>
      )}
    </span>
  );
}

// ─── One row ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<SurfaceStatus, 'neutral' | 'pass' | 'fail' | 'flake'> = {
  COVERED: 'pass',
  ASSERTED_NOT_RUN: 'flake',
  UNCOVERED: 'fail',
  UNKNOWN: 'neutral',
  WAIVED: 'neutral',
};

function SurfaceRow({
  entry,
  onWaive,
  onWithdraw,
  withdrawing,
}: {
  entry: SurfaceItemCoverage;
  onWaive: () => void;
  onWithdraw: () => void;
  withdrawing: boolean;
}) {
  const { item, status, matches, verification, waiver } = entry;

  return (
    <div className="border-line border-b py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/*
         * Mono, and the first thing on the row. These are machine strings —
         * `/orders/:id`, `POST /api/refunds` — and the point of the screen is
         * that the reader can paste one into a waiver file, a ticket or a grep.
         */}
        <span className="text-row text-ink min-w-0 font-mono break-all">{item.label}</span>
        <Badge tone={STATUS_TONE[status]}>{SURFACE_STATUS_LABELS[status]}</Badge>
        {item.origin === 'SOURCE_ONLY' && (
          /*
           * The row no runtime-only tool can produce. Worth a chip rather than
           * a line of prose, because it is why this item is on the list at all.
           */
          <Badge>never reached by a crawl</Badge>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {status === 'WAIVED' ? (
            <button
              type="button"
              onClick={onWithdraw}
              disabled={withdrawing}
              className="text-accent text-[12px] hover:underline disabled:opacity-50"
            >
              {withdrawing ? 'withdrawing…' : 'withdraw the waiver'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onWaive}
              className="text-ink-faint hover:text-ink text-[12px]"
            >
              waive…
            </button>
          )}
        </span>
      </div>

      {/*
       * The declaring file. NOT a link: /editor opens QAAI test files by id,
       * and this path is in the customer's own repository, which the cockpit
       * has no viewer for. A link that 404s would be worse than a path somebody
       * can copy. (The matched test below IS linkable, and is linked.)
       */}
      <p className="text-ink-faint text-micro mt-1 font-mono break-all">
        {item.file ?? 'no declaring file — this item came from a crawl'}
        {item.file && item.line !== null && <span className="tabular-nums">:{item.line}</span>}
        {item.detector && <span className="ml-2">via {item.detector}</span>}
      </p>

      {/* The sentence that justifies the item's existence, in the customer's
          terms. This is what makes the denominator auditable rather than
          asserted, so it is on the row and never behind a disclosure. */}
      <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">{item.evidence}</p>

      {matches.length > 0 && (
        <p className="text-ink-dim text-row-sub mt-1.5">
          {matches.length === 1 ? 'Matched test:' : `Matched tests (${matches.length}):`}{' '}
          {matches.slice(0, 4).map((match, index) => (
            <span key={match.testId}>
              {index > 0 && ', '}
              <Link href={`/editor?test=${match.testId}`} className="text-accent hover:underline">
                {match.testName}
              </Link>
              <span className="text-ink-faint"> ({match.basis.toLowerCase()})</span>
            </span>
          ))}
          {matches.length > 4 && (
            <span className="text-ink-faint"> and {matches.length - 4} more</span>
          )}
        </p>
      )}

      {status === 'ASSERTED_NOT_RUN' && (
        <p className="text-flake text-row-sub mt-1">
          The test exists and has never executed, so it has not been shown to pass or to assert
          anything. Not counted as covered.
        </p>
      )}

      {status === 'COVERED' && verification.mutationKilled !== true && (
        <p className="text-ink-faint text-row-sub mt-1">
          Its test runs, but no mutation result exists for it — known to execute, not known to
          assert anything meaningful.
        </p>
      )}

      {waiver && (
        <div className="border-line mt-2 border-l-2 pl-3">
          <p className="text-ink-dim text-row-sub leading-relaxed">{waiver.reason}</p>
          <p className="text-ink-faint text-meta mt-1 font-mono">
            {waiver.byEmail ?? waiver.byUserId ?? 'unknown owner'} ·{' '}
            {waiver.createdAtIso.slice(0, 10)} ·{' '}
            {waiver.expiresAtIso ? (
              <>expires {waiver.expiresAtIso.slice(0, 10)}</>
            ) : (
              /* The state that shrinks a denominator forever. Said plainly. */
              <span className="text-flake">no expiry</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────────────

/**
 * Kind, state and provenance.
 *
 * Every change resets `offset` to zero: keeping it would land the reader on
 * page 4 of a three-page result and render an empty list, which on this screen
 * reads as "nothing is untested".
 */
function Filters({
  report,
  filters,
  onFilters,
}: {
  report: SurfaceReport;
  filters: SurfaceFilters;
  onFilters: (next: SurfaceFilters) => void;
}) {
  const set = (patch: Partial<SurfaceFilters>) => onFilters({ ...filters, offset: 0, ...patch });

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  return (
    <div className="space-y-2">
      <FilterRow label="Axis">
        <Chip active={filters.kinds.length === 0} onClick={() => set({ kinds: [] })}>
          all
        </Chip>
        {MEASURED_SURFACE_KINDS.map((kind) => (
          <Chip
            key={kind}
            active={filters.kinds.includes(kind)}
            onClick={() => set({ kinds: toggle(filters.kinds, kind) })}
          >
            {SURFACE_KIND_LABELS[kind]}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="State">
        {/* "all" is sent as every value, not as an absent parameter — the
            endpoint defaults an absent `status` to UNCOVERED, which would show
            gaps only under a chip claiming everything was selected. */}
        <Chip active={filters.statuses.length === 0} onClick={() => set({ statuses: [] })}>
          all
        </Chip>
        {SURFACE_STATUSES.map((status) => (
          <Chip
            key={status}
            active={filters.statuses.includes(status)}
            onClick={() => set({ statuses: toggle(filters.statuses, status) })}
          >
            {SURFACE_STATUS_LABELS[status]}
          </Chip>
        ))}
      </FilterRow>

      <FilterRow label="Provenance">
        <Chip active={filters.origin === null} onClick={() => set({ origin: null })}>
          all
        </Chip>
        {SURFACE_ORIGINS.map((origin) => (
          <Chip
            key={origin}
            active={filters.origin === origin}
            onClick={() => set({ origin: filters.origin === origin ? null : origin })}
            title={SURFACE_ORIGIN_LABELS[origin]}
          >
            {ORIGIN_CHIP[origin]}
          </Chip>
        ))}
      </FilterRow>

      <p className="text-ink-faint text-meta">
        <span className="tabular-nums">{report.total}</span> of{' '}
        <span className="tabular-nums">
          {report.snapshot.totals.denominator + report.snapshot.totals.waived}
        </span>{' '}
        inventory items match.
      </p>
    </div>
  );
}

/** Short enough for a chip; the full sentence is the chip's title attribute. */
const ORIGIN_CHIP: Record<SurfaceOrigin, string> = {
  SOURCE_ONLY: 'source only',
  CRAWL_ONLY: 'crawl only',
  BOTH: 'both',
};

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-meta text-ink-faint w-20 shrink-0 font-mono tracking-[0.08em] uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        'text-meta rounded-full border px-2 py-0.5 font-mono transition-colors',
        active ? 'border-accent text-accent' : 'border-line text-ink-faint hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
