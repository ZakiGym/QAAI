'use client';

import { PATH_CHOICES, type FunnelPath } from './funnel';
import { cn } from '../../lib/cn';

/**
 * Step 1 — "where do your tests come from?"
 *
 * The screen this replaces asked a different first question: it asked for a URL
 * to crawl, and that was the only question it could ask. Someone arriving with
 * a repo and no deployed environment, or with a suite already written, or
 * wanting to type a test themselves, had no answer that fitted — and the one
 * escape hatch (`?mode=import`) was a query parameter, not a choice on screen.
 *
 * Four cards, and every one of them leads somewhere real. Radios rather than
 * buttons because this is a question with one answer, and because the keyboard
 * and a screen reader should hear it that way; the card is the label.
 */
export function PathPicker({
  value,
  onChange,
  children,
}: {
  value: FunnelPath | null;
  onChange: (path: FunnelPath) => void;
  /** Rendered inside the selected card — the folder pick belongs to its choice. */
  children?: (path: FunnelPath) => React.ReactNode;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="sr-only">Where do your tests come from?</legend>
      <div className="flex flex-col gap-2.5">
        {PATH_CHOICES.map((choice) => {
          const selected = value === choice.id;
          return (
            <div key={choice.id}>
              <label
                className={cn(
                  'block cursor-pointer rounded-lg border px-4 py-3.5 transition-colors',
                  selected
                    ? 'border-accent bg-[color-mix(in_srgb,var(--color-accent)_5%,transparent)]'
                    : 'border-line hover:border-line-strong',
                )}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="funnel-path"
                    value={choice.id}
                    checked={selected}
                    onChange={() => onChange(choice.id)}
                    className="accent-accent mt-[3px]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-row font-medium">{choice.label}</span>
                      {choice.headline && (
                        <span className="text-meta text-accent rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-[7px] py-[2px] font-mono tracking-[0.05em]">
                          START HERE
                        </span>
                      )}
                    </div>
                    <p className="text-ink-dim text-row-sub mt-1.5 leading-relaxed">
                      {choice.body}
                    </p>
                    <p className="text-ink-faint text-micro mt-1.5 font-mono">
                      needs: {choice.needs}
                    </p>
                  </div>
                </div>
              </label>

              {selected && children?.(choice.id)}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
