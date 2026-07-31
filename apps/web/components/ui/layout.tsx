'use client';

import { cn } from '../../lib/cn';

/**
 * Page-level layout primitives.
 *
 * Every page re-declared its own `<main className="mx-auto max-w-Nxl px-6 py-10">`
 * and its own `<h1>`, so container widths ran max-w-2xl → 3xl → 4xl → 5xl with
 * no rule, and h1 sizes drifted across four values (text-lg, text-2xl, text-3xl,
 * text-5xl) with one page having no h1 at all. Navigating between two screens
 * felt like navigating between two products.
 */

/**
 * One content column, three widths.
 *
 * `wide` is for lists and dashboards, `narrow` for forms and settings — reading
 * measure, not taste. `full` opts out for the console screens (cockpit, editor)
 * that are genuinely edge-to-edge.
 */
export function Page({
  width = 'wide',
  className,
  children,
}: {
  width?: 'narrow' | 'wide' | 'full';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <main
      className={cn(
        width === 'full' ? 'flex h-full flex-col' : 'mx-auto w-full px-6 py-10',
        width === 'narrow' && 'max-w-3xl',
        width === 'wide' && 'max-w-5xl',
        className,
      )}
    >
      {children}
    </main>
  );
}

/** One heading treatment. `actions` sit on the heading's baseline, right-aligned. */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6 flex items-start gap-4', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-ink-dim text-body-sm mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Section eyebrow — the uppercase label above a group. Was hand-rolled ~12 times. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-micro text-ink-faint mb-3 font-semibold tracking-wider uppercase">
      {children}
    </h2>
  );
}

export function Card({
  className,
  children,
  interactive = false,
}: {
  className?: string;
  children: React.ReactNode;
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        'border-line bg-surface-1 rounded-lg border',
        interactive && 'lift',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The status/meta chip.
 *
 * Seven chips render at `text-[9px]` today — below the design system's own
 * 10px floor and below any reasonable accessibility minimum. This is 10px and
 * that is the floor.
 */
export function Badge({
  tone = 'neutral',
  mono = false,
  className,
  children,
}: {
  tone?: 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const TONE = {
    neutral: 'border-line text-ink-faint',
    accent: 'border-accent/50 text-accent',
    pass: 'border-pass/40 text-pass',
    fail: 'border-fail/50 text-fail',
    flake: 'border-flake/40 text-flake',
  } as const;

  return (
    <span
      className={cn(
        'text-meta inline-flex shrink-0 items-center rounded border px-1.5 py-0.5',
        mono && 'font-mono',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Tab strip. Was implemented three times — two of them byte-identical
 * copy-paste between /settings and /quality.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="border-line mb-6 flex gap-1 border-b" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
            active === tab.id
              ? 'border-accent text-ink'
              : 'text-ink-dim hover:text-ink border-transparent',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="text-ink-faint text-micro ml-1.5 tabular-nums">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Loading placeholder.
 *
 * There were zero skeletons in the app — every data-backed page popped from
 * empty to full, and on the three trust screens the collections initialise to
 * `[]`, so the *empty state* was what rendered during every fetch. A user
 * watching a slow request was being told there was nothing there.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-surface-2 animate-pulse rounded', className)}
    />
  );
}

/** N skeleton rows shaped like the list they stand in for. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-line divide-y', className)} aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
