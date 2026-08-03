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
 * One content column, one width per section.
 *
 * The measures come from the redesign brief and are deliberately not a generic
 * sm/md/lg scale: each is the width at which that section's own densest row
 * stops wrapping. Runs needs 1080 for the run-log grid; Settings is a reading
 * column at 760 and gets narrower, not wider, than everything else.
 *
 * `wide` and `narrow` are the names thirty screens already pass. They stay, as
 * aliases onto the two extremes of the new scale, so no screen breaks while the
 * sections move over one at a time.
 */
const WIDTH = {
  runs: 'max-w-[1080px]',
  triage: 'max-w-[980px]',
  insights: 'max-w-[980px]',
  setup: 'max-w-[940px]',
  settings: 'max-w-[760px]',
  wide: 'max-w-[1080px]',
  narrow: 'max-w-[760px]',
  /* Cockpit and editor are genuinely edge-to-edge and own their own scrolling. */
  full: '',
} as const;

export function Page({
  width = 'wide',
  className,
  children,
}: {
  width?: keyof typeof WIDTH;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <main
      className={cn(
        // 44px top / 40px sides. The generous top gutter is what lets a 34px
        // serif title read as a title rather than as the first row of a list.
        width === 'full' ? 'flex h-full flex-col' : 'mx-auto w-full px-10 pt-11 pb-16',
        WIDTH[width],
        className,
      )}
    >
      {children}
    </main>
  );
}

/**
 * One heading treatment.
 *
 * `eyebrow` is the mono line above the title that says which project and which
 * environment you are looking at (`STOREFRONT · STAGING`). It exists because the
 * sidebar's project switcher is easy to miss and every one of these screens is
 * destructive-adjacent — you should never have to guess which app you are about
 * to run a suite against.
 *
 * `size` is the 34px cockpit-class title against the 26px compact one. Sections
 * with a tab strip directly under the title use the compact size, otherwise the
 * title and the strip fight each other for the top of the page.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
  size = 'lg',
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  size?: 'lg' | 'sm';
  className?: string;
}) {
  return (
    // `items-end`: actions sit on the bottom edge of the title block, so they
    // stay put whether or not the page has an eyebrow and a subtitle.
    <div className={cn('mb-6 flex items-end gap-4', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="text-meta text-ink-faint font-mono tracking-[0.1em] uppercase">{eyebrow}</p>
        )}
        <h1
          className={cn(
            'font-display font-semibold tracking-[-0.01em]',
            size === 'lg' ? 'text-display-lg' : 'text-display',
            // After the size, not before: a `text-*` utility can carry its own
            // line-height, so tailwind-merge treats it as beating any `leading-*`
            // that came earlier and drops it.
            'leading-[1.1]',
            eyebrow && 'mt-1.5',
          )}
        >
          {title}
        </h1>
        {subtitle && <p className="text-ink-dim text-row mt-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pb-0.5">{actions}</div>}
    </div>
  );
}

/**
 * Section eyebrow — the mono uppercase label above a group (NEEDS YOU, FLEET,
 * RUN LOG). Was hand-rolled ~12 times.
 *
 * It sits close to what it labels on purpose: the gap below it is smaller than
 * the gap above it, which is the whole reason it reads as belonging to the list
 * rather than floating between two of them.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        'text-micro text-ink-faint mb-2.5 font-mono font-semibold tracking-[0.1em] uppercase',
        className,
      )}
    >
      {children}
    </h2>
  );
}

/**
 * A card, for the things that are genuinely cards.
 *
 * Lists are NOT cards any more — a run log, a secrets table and a verdict queue
 * are hairline rows on the page background, because twenty boxes stacked
 * vertically is nineteen borders nobody reads. What is left here is the real
 * thing: a fleet tile, a heal proposal, a detection result — an object you can
 * pick up and act on, one at a time.
 */
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
      className={cn('border-line bg-surface-1 rounded-lg border', interactive && 'lift', className)}
    >
      {children}
    </div>
  );
}

/**
 * The status chip.
 *
 * Mono by default: almost every chip in this UI holds a machine word — FAIL,
 * REAL BUG · 0.92, SELECTOR ONLY, QUARANTINED, CRITICAL — and setting those in
 * the UI face makes them read as prose the product wrote rather than as a value
 * it is reporting. Chips that really do hold a sentence pass `mono={false}`.
 *
 * Seven chips rendered at `text-[9px]` before this existed — below the design
 * system's own 10px floor and below any reasonable accessibility minimum. This
 * is 10px and that is the floor.
 */
const BADGE_TONE = {
  neutral: 'border-line text-ink-faint',
  accent: 'border-accent/40 text-accent',
  pass: 'border-pass/40 text-pass',
  fail: 'border-fail/40 text-fail',
  flake: 'border-flake/40 text-flake',
} as const;

/*
 * 12% of the tone against the page, not a pre-mixed colour: `color-mix` resolves
 * against whatever `--color-fail` currently is, so one class covers both themes
 * and stays correct when the accent is switched under it.
 */
const BADGE_TINT = {
  neutral: 'bg-surface-2',
  accent: 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
  pass: 'bg-[color-mix(in_srgb,var(--color-pass)_12%,transparent)]',
  fail: 'bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]',
  flake: 'bg-[color-mix(in_srgb,var(--color-flake)_12%,transparent)]',
} as const;

export function Badge({
  tone = 'neutral',
  mono = true,
  tint = false,
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONE;
  mono?: boolean;
  /** Fills the chip with 12% of its tone. For the one chip that must be seen. */
  tint?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'text-meta inline-flex shrink-0 items-center rounded-sm border px-[7px] py-[2px] font-medium tracking-[0.05em]',
        mono && 'font-mono',
        BADGE_TONE[tone],
        tint && BADGE_TINT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Tabs INSIDE a page — Settings, Quality.
 *
 * Section-level navigation (Runs / Triage / Tests / …) is the shell's job and
 * lives in the strip under the page title; this is the level below that, for a
 * screen that genuinely has two views of the same thing. Both are drawn the
 * same way on purpose: mono, uppercase, accent underline. A user should not
 * have to learn that one row of tabs changes the URL and the other does not.
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
    <div className="border-line mb-6 flex flex-wrap gap-[22px] border-b" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'text-micro -mb-px border-b-2 px-0.5 pb-[9px] font-mono tracking-[0.08em] uppercase transition-colors',
            active === tab.id
              ? 'border-accent text-ink'
              : 'text-ink-faint hover:text-ink-dim border-transparent',
          )}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1.5 tabular-nums opacity-70">{tab.count}</span>
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
    <div aria-hidden="true" className={cn('bg-surface-2 animate-pulse rounded-sm', className)} />
  );
}

/**
 * N skeleton rows shaped like the list they stand in for.
 *
 * Hairline rows with no outer box and no horizontal padding, because that is
 * what the real list is now — a skeleton that is a different shape from its
 * content produces a visible jump on every load, which is the one thing a
 * skeleton exists to prevent.
 */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('divide-line divide-y', className)} aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 py-3">
          <Skeleton className="h-1.5 w-1.5 rounded-full" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
