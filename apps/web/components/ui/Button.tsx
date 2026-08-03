'use client';

import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * The button.
 *
 * There were 83 raw `<button>` elements across 28 files, about 25 of them
 * re-implementing the primary style by hand, and the padding alone had drifted
 * to six different values: px-2.5 py-1, px-3 py-1, px-3 py-1.5, px-3.5 py-2,
 * px-4 py-2, px-5 py-2.5. Nothing lines up optically between two screens
 * because nothing shares a source.
 *
 * The token layer was already written and documented; this is the component
 * layer that makes it binding.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  /*
   * `text-accent-ink`, never `text-white`. The accent is switchable and two of
   * the three options — mist and sage — are light enough in dark mode that white
   * on them is unreadable; the token flips to near-black for those and back to
   * white for iris in light mode. Hard-coding white got it wrong in four of the
   * six theme × accent combinations.
   */
  primary: 'bg-accent text-accent-ink font-semibold hover:opacity-90',
  secondary:
    'border-line text-ink-dim hover:text-ink hover:border-line-strong border bg-transparent',
  ghost: 'text-ink-dim hover:text-ink hover:bg-surface-2 bg-transparent',
  // Destructive is deliberately an outline, not a filled red slab. A row of
  // solid red buttons trains people to ignore red; the weight belongs on the
  // confirmation, not on the trigger.
  danger: 'border-fail/50 text-fail hover:bg-fail/10 border bg-transparent',
};

const SIZE: Record<Size, string> = {
  sm: 'gap-1.5 px-[11px] py-[5px] text-[12px]',
  md: 'text-row-sub gap-[7px] px-3.5 py-[7px]',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Every button in the app was missing this and defaulted to submit,
      // which silently submits the enclosing form.
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      // Announce the busy state rather than only showing a spinner.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap transition-[opacity,background-color,border-color] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

/**
 * The app had no spinner at all — `animate-pulse` on a dot was the only
 * in-progress signal anywhere.
 */
function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
