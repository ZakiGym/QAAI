'use client';

import { useState } from 'react';
import { duration } from '../ui';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';

/**
 * A deploy gate, as a sentence.
 *
 * `MAX_FLAKE_RATE` is not a sentence, and a rule nobody can read is a rule
 * nobody can check — these decide whether a red build stops a merge, which
 * makes them the most consequential configuration in the product. So the row
 * leads with what the rule does in English, and the editor is folded away
 * behind `edit` until somebody actually wants to change a number.
 */

export type GateRule =
  | { kind: 'BLOCK_ON_VERDICT'; verdict: string; onlyPriorities: string[] }
  | { kind: 'MAX_FLAKE_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MAX_P95_LATENCY_MS'; ms: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MIN_PASS_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' };

const VERDICTS = ['REAL_BUG', 'INTENDED_CHANGE', 'FLAKE', 'ENV_ISSUE'] as const;
const PRIORITIES = ['CRITICAL_PATH', 'IMPORTANT', 'NICE_TO_HAVE'] as const;

const humanise = (value: string) => value.toLowerCase().replace(/_/g, ' ');

/** A verdict rule always blocks; the others carry their own severity. */
export const actionOf = (rule: GateRule): 'WARN' | 'BLOCK' =>
  'action' in rule ? rule.action : 'BLOCK';

export function describeRule(rule: GateRule): string {
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT':
      return `Block the deploy when triage calls a failure a ${humanise(rule.verdict)}${
        rule.onlyPriorities.length
          ? `, but only for ${rule.onlyPriorities.map(humanise).join(' or ')} tests`
          : ''
      }.`;
    case 'MAX_FLAKE_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when more than ${rule.ratePercent}% of tests are flaky.`;
    case 'MAX_P95_LATENCY_MS':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the 95th-percentile test takes longer than ${duration(rule.ms)}.`;
    case 'MIN_PASS_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the pass rate falls below ${rule.ratePercent}%.`;
  }
}

const CONTROL =
  'border-line text-row-sub focus:border-accent rounded-md border bg-transparent px-2 py-1 outline-none transition-colors';

export function GateRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: GateRule;
  onChange: (next: GateRule) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const blocks = actionOf(rule) === 'BLOCK';

  return (
    <div className="border-line border-b">
      <div className="flex items-center gap-3 py-[11px]">
        <Badge tone={blocks ? 'fail' : 'flake'} tint>
          {actionOf(rule)}
        </Badge>
        <p className="text-row min-w-0 flex-1">{describeRule(rule)}</p>
        <button
          type="button"
          onClick={() => setEditing((open) => !open)}
          aria-expanded={editing}
          className="text-ink-faint hover:text-ink shrink-0 text-[11.5px] transition-colors"
        >
          {editing ? 'done' : 'edit'}
        </button>
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-2 pb-3.5">
          {rule.kind === 'BLOCK_ON_VERDICT' ? (
            <>
              <select
                aria-label="Which verdict blocks"
                className={CONTROL}
                value={rule.verdict}
                onChange={(e) => onChange({ ...rule, verdict: e.target.value })}
              >
                {VERDICTS.map((verdict) => (
                  <option key={verdict} value={verdict}>
                    {humanise(verdict)}
                  </option>
                ))}
              </select>
              <span className="text-ink-faint text-micro">
                {/* Empty means every test — said here, because an unticked row
                    of boxes reads as "nothing is covered". */}
                on
              </span>
              {PRIORITIES.map((priority) => (
                <label
                  key={priority}
                  className="text-ink-dim text-micro flex items-center gap-1.5 font-mono"
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={rule.onlyPriorities.includes(priority)}
                    onChange={(e) =>
                      onChange({
                        ...rule,
                        onlyPriorities: e.target.checked
                          ? [...rule.onlyPriorities, priority]
                          : rule.onlyPriorities.filter((p) => p !== priority),
                      })
                    }
                  />
                  {humanise(priority)}
                </label>
              ))}
              {rule.onlyPriorities.length === 0 && (
                <span className="text-ink-faint text-micro">— none ticked means every test</span>
              )}
            </>
          ) : (
            <>
              <input
                type="number"
                aria-label={rule.kind === 'MAX_P95_LATENCY_MS' ? 'Milliseconds' : 'Percent'}
                className={`${CONTROL} w-24 tabular-nums`}
                value={rule.kind === 'MAX_P95_LATENCY_MS' ? rule.ms : rule.ratePercent}
                min={0}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (!Number.isFinite(value)) return;
                  onChange(
                    rule.kind === 'MAX_P95_LATENCY_MS'
                      ? { ...rule, ms: value }
                      : { ...rule, ratePercent: value },
                  );
                }}
              />
              <span className="text-ink-faint text-micro">
                {rule.kind === 'MAX_P95_LATENCY_MS' ? 'ms' : '%'}
              </span>
              <select
                aria-label="What happens when it trips"
                className={CONTROL}
                value={rule.action}
                onChange={(e) =>
                  onChange({ ...rule, action: e.target.value as 'WARN' | 'BLOCK' })
                }
              >
                <option value="WARN">warn — recorded, merge allowed</option>
                <option value="BLOCK">block — fails the CI gate</option>
              </select>
            </>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            className="text-fail hover:text-fail ml-auto"
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
