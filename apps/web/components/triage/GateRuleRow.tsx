'use client';

import { useState } from 'react';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';
import {
  PRIORITIES,
  VERDICTS,
  actionOf,
  describeRule,
  humanise,
  isEditableRule,
  type StoredGateRule,
} from './gate-rules';

/* Re-exported: /quality imports the type and the row from this module. */
export { actionOf, describeRule, isEditableRule } from './gate-rules';
export type { GateRule, StoredGateRule } from './gate-rules';

/**
 * A deploy gate, as a sentence.
 *
 * `MAX_FLAKE_RATE` is not a sentence, and a rule nobody can read is a rule
 * nobody can check — these decide whether a red build stops a merge, which
 * makes them the most consequential configuration in the product. So the row
 * leads with what the rule does in English, and the editor is folded away
 * behind `edit` until somebody actually wants to change a number.
 */

const CONTROL =
  'border-line text-row-sub focus:border-accent rounded-md border bg-transparent px-2 py-1 outline-none transition-colors';

export function GateRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: StoredGateRule;
  onChange: (next: StoredGateRule) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const action = actionOf(rule);
  const editable = isEditableRule(rule);

  return (
    <div className="border-line border-b">
      <div className="flex items-center gap-3 py-[11px]">
        <Badge tone={action === 'BLOCK' ? 'fail' : action === 'WARN' ? 'flake' : 'neutral'} tint>
          {/* A rule whose severity this build cannot read says so, rather than
              being badged BLOCK on a guess. */}
          {action ?? 'rule'}
        </Badge>
        <p className="text-row min-w-0 flex-1">{describeRule(rule)}</p>
        {/* No `edit` for a kind with no controls: the panel below would write
            this editor's field names onto a rule that does not have them. */}
        {editable && (
          <button
            type="button"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
            className="text-ink-faint hover:text-ink shrink-0 text-[11.5px] transition-colors"
          >
            {editing ? 'done' : 'edit'}
          </button>
        )}
        {!editable && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRemove}
            className="text-fail hover:text-fail shrink-0"
          >
            Remove
          </Button>
        )}
      </div>

      {editing && editable && (
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
