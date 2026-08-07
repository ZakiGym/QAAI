'use client';

import type { TestType } from '@qaai/shared';
import { testTypeChoices } from './funnel';
import { cn } from '../../lib/cn';

/**
 * Step 3 — which kinds of test you want.
 *
 * The list is `CREATABLE_TEST_TYPES`, which is derived: a type appears exactly
 * when `NEW_TEST_TEMPLATES` has a template for it, and the runner's own test
 * holds every template to its plugin's `validate()`. So every box here creates
 * a file that is runnable the moment it exists — never a scaffold whose first
 * run is FAILED "invalid spec". The picker cannot offer the nineteen the enum
 * knows about, because eleven of them are backed by nothing but the enum.
 *
 * The `modelFree` split is the second honesty, and it is about a different
 * mechanism. Every type here can be SCAFFOLDED from a template with no key.
 * Only six can be WRITTEN from a crawl with no key — the ones whose required
 * fields a crawl actually supplies. This deployment has no ANTHROPIC_API_KEY,
 * so that distinction decides what the crawl produces, and it is stated at the
 * moment of choosing rather than discovered afterwards.
 */
export function TestTypesStep({
  selected,
  onToggle,
  onClear,
  disabled,
}: {
  selected: ReadonlySet<TestType>;
  onToggle: (type: TestType) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const choices = testTypeChoices();

  return (
    <div className="mt-5">
      <div className="border-line divide-line divide-y rounded-lg border">
        {choices.map((choice) => {
          const checked = selected.has(choice.type);
          return (
            <label
              key={choice.type}
              className={cn(
                'flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors',
                checked && 'bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)]',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(choice.type)}
                disabled={disabled}
                className="accent-accent mt-[3px]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-row-sub font-medium">{choice.label}</span>
                  <span
                    className={cn(
                      'text-meta rounded-sm border px-[7px] py-[2px] font-mono tracking-[0.05em]',
                      choice.modelFree
                        ? 'border-pass/40 text-pass'
                        : 'border-line text-ink-faint',
                    )}
                  >
                    {choice.modelFree ? 'NO KEY NEEDED' : 'NEEDS A MODEL'}
                  </span>
                </span>
                <span className="text-ink-faint text-micro mt-1 block leading-relaxed">
                  {choice.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-ink-faint text-micro leading-relaxed">
          <span className="text-pass font-mono">NO KEY NEEDED</span> means QAAI can write that type
          from a crawl on its own — the spec's required fields are things the Explorer sees.{' '}
          <span className="font-mono">NEEDS A MODEL</span> means the plan is written either way,
          but turning it into code waits for <code className="font-mono">ANTHROPIC_API_KEY</code>.
          A starter file for every type you tick is created immediately, with or without a key.
        </p>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="text-ink-faint hover:text-ink shrink-0 text-[12px] transition-colors"
          >
            untick all
          </button>
        )}
      </div>
    </div>
  );
}
