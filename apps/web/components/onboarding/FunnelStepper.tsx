'use client';

import { cn } from '../../lib/cn';

/**
 * Where you are in the four questions.
 *
 * Derived from the current step and the paths already behind it rather than
 * tracked separately — a stepper that can disagree with the screen it labels is
 * worse than no stepper. The one it replaces hard-coded its last entry to
 * `pending`, so FIRST RUN could never light up no matter what happened.
 *
 * A completed step is a button, because every step is revisitable and saying so
 * only in prose ("you can change this later") while drawing an inert row is the
 * kind of small contradiction that teaches people not to trust the screen.
 */

export const FUNNEL_STEPS = ['SOURCE', 'STACK', 'TEST TYPES', 'RESULT'] as const;

export function FunnelStepper({
  current,
  furthest,
  onJump,
}: {
  /** 1-based. */
  current: number;
  /** The highest step reached, so a step ahead of it is not offered as a jump. */
  furthest: number;
  onJump: (step: number) => void;
}) {
  return (
    <ol className="flex flex-wrap font-mono text-[10.5px] tracking-[0.06em]">
      {FUNNEL_STEPS.map((label, i) => {
        const index = i + 1;
        const state = index < current ? 'done' : index === current ? 'active' : 'pending';
        // Only a step already visited can be jumped to. Forward movement is the
        // funnel's job — a jump to step 3 from step 1 skips the two answers the
        // result is assembled from.
        const jumpable = index <= furthest && index !== current;

        return (
          <li
            key={label}
            className={cn(
              'flex items-center first:pl-0',
              i > 0 && 'border-line border-l',
              state === 'done' && 'text-pass',
              state === 'active' && 'text-ink',
              state === 'pending' && 'text-ink-faint',
            )}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <button
              type="button"
              disabled={!jumpable}
              onClick={() => onJump(index)}
              className={cn(
                'flex items-center gap-[7px] px-[18px] py-1 transition-opacity',
                i === 0 && 'pl-0',
                jumpable ? 'hover:opacity-70' : 'cursor-default',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px]',
                  state === 'done' &&
                    'bg-[color-mix(in_srgb,var(--color-pass)_15%,transparent)]',
                  state === 'active' && 'bg-accent text-accent-ink',
                  state === 'pending' && 'border-line border',
                )}
              >
                {state === 'done' ? '✓' : index}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The promise, repeated on every step.
 *
 * The user's own framing of this product was "we set up our application to
 * their need — but not strictly, they can change it whenever". Saying that once
 * on the first screen is not the same as saying it where the irreversible-
 * looking choice is actually made, so it sits under all four.
 *
 * It names the destination rather than gesturing at "settings", and that
 * destination is real: `PATCH /projects/:id` is what the App panel there calls.
 */
export function ChangeableLater() {
  return (
    <p className="text-ink-faint text-micro mt-6 leading-relaxed">
      None of this is locked in. The language, the framework, the test types and the URL are all
      editable afterwards in{' '}
      <a href="/environments" className="text-ink-dim hover:text-ink underline underline-offset-2">
        Setup → Environments
      </a>
      , and nothing you pick here prevents anything later.
    </p>
  );
}
