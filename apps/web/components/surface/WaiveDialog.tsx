'use client';

import { useEffect, useState } from 'react';
import type { SurfaceItemCoverage } from '@qaai/shared';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import {
  WAIVER_DEFAULT_DAYS,
  WAIVER_REASON_MIN,
  checkWaiver,
  defaultExpiry,
  waiverBody,
  type WaiverDraft,
} from '../../lib/surface';

/**
 * Recording a decision not to test something.
 *
 * A waiver is the only thing on this screen that changes the number, because
 * it takes an item OUT of the denominator — so the dialog is built around the
 * two fields that keep that honest:
 *
 *   The REASON is required and must be readable months later. Ten characters is
 *   the API's floor and it is checked here too, so the refusal arrives while
 *   the row it is about is still on screen.
 *
 *   The EXPIRY is pre-filled and prominent, not an optional extra at the
 *   bottom. A waiver with no expiry is how a denominator quietly shrinks
 *   forever: nobody revisits a decision that never comes back, and a coverage
 *   figure that rises because the inventory shrank is the worst thing this
 *   product could be caught printing. Clearing the field is allowed — some
 *   exclusions really are permanent — but it says what it means first.
 */

export function WaiveDialog({
  entry,
  onClose,
  onSubmit,
}: {
  entry: SurfaceItemCoverage | null;
  onClose: () => void;
  /** Resolves when the API has accepted it; rejects to keep the dialog open. */
  onSubmit: (body: ReturnType<typeof waiverBody>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<WaiverDraft>({ reason: '', expiresAt: '' });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const key = entry?.item.key ?? null;

  // Keyed on the item, not on `open`: waiving a second row must not inherit the
  // first row's reason, which would record a justification about another item.
  useEffect(() => {
    if (!key) return;
    setDraft({ reason: '', expiresAt: defaultExpiry() });
    setProblem(null);
  }, [key]);

  if (!entry) return null;

  /*
   * Pulled out of the prop before the callbacks close over it. TypeScript does
   * not carry the narrowing above into a nested function for a parameter
   * binding, and a non-null assertion inside `submit` would be an assertion
   * about something the early return already proved.
   */
  const item = entry.item;
  const check = checkWaiver(draft);

  async function submit() {
    const verdict = checkWaiver(draft);
    if (verdict.problem) {
      setProblem(verdict.problem);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(waiverBody(item.key, draft));
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The waiver was not recorded.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Waive this item"
      description="It leaves the denominator, so the percentage above will rise. That is only honest if the reason is on the record."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            Record the waiver
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="text-meta text-ink-faint mb-1 font-mono tracking-[0.08em] uppercase">
            The item
          </p>
          <p className="text-ink text-body-sm font-mono break-all">{item.label}</p>
          <p className="text-ink-faint text-micro mt-1 font-mono break-all">{item.key}</p>
        </div>

        <div>
          <label
            htmlFor="waiver-reason"
            className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
          >
            Why this is not worth testing
          </label>
          <textarea
            id="waiver-reason"
            data-autofocus
            rows={3}
            value={draft.reason}
            onChange={(event) => {
              setDraft((current) => ({ ...current, reason: event.target.value }));
              if (problem) setProblem(null);
            }}
            placeholder="Retired with the v2 billing cutover — the route 404s in staging and is deleted next sprint."
            className="border-line focus:border-accent placeholder:text-ink-faint text-ink-dim text-body-sm w-full resize-y rounded-md border bg-transparent p-2.5 leading-relaxed outline-none"
          />
          <p className="text-ink-faint text-micro mt-1.5 font-mono tabular-nums">
            {draft.reason.trim().length} / {WAIVER_REASON_MIN} characters minimum
          </p>
        </div>

        <div>
          <Field
            type="date"
            label="Expires"
            value={draft.expiresAt}
            onChange={(event) => {
              setDraft((current) => ({ ...current, expiresAt: event.target.value }));
              if (problem) setProblem(null);
            }}
          />
          {check.permanent ? (
            /*
             * Deliberately loud. This is the state that does the damage, and it
             * is reached by clearing a field — which is exactly the kind of
             * thing that happens by accident and is never noticed again.
             */
            <p className="text-flake text-row-sub mt-2 leading-relaxed">
              With no expiry this item leaves the denominator permanently. Nobody will be prompted
              to revisit it, and every future percentage will be computed over a smaller application
              than you have.
            </p>
          ) : (
            <p className="text-ink-faint text-row-sub mt-2">
              Pre-filled {WAIVER_DEFAULT_DAYS} days out. When it lapses the item returns to the
              denominator on its own, so the decision gets looked at again.
            </p>
          )}
        </div>

        {problem && (
          <p role="alert" className="text-fail text-body-sm">
            {problem}
          </p>
        )}
      </div>
    </Modal>
  );
}
