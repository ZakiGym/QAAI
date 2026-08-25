'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { describeCron, formatZone } from './cadence';
import { Picker, TargetFields, browserTimeZone, timeZoneOptions } from './pickers';
import type { EnvironmentRef, Schedule, ScheduleDraft, SuiteRef } from './types';

/**
 * Create or edit a schedule.
 *
 * One dialog for both, because they ask for exactly the same five things and a
 * separate create form is how the two drift until only one of them validates
 * the cron.
 *
 * ── The preview is the feature ──────────────────────────────────────────────
 *
 * Under the cron field, in prose, is what that expression actually means, and
 * it updates as you type. A cron is write-only for most people: they copy one
 * from somewhere, save it, and find out what it does in a week's time when the
 * suite either ran or did not. Saying "every weekday at 3:00 AM" back to them
 * before they press Save is the difference between configuring a schedule and
 * hoping about one.
 *
 * The zone is printed under it with its current UTC offset, because that is the
 * clock the run actually happens on — the worker parses each schedule in its
 * OWN stored zone, not the reader's — and "3:00 AM" alone is exactly the kind
 * of half-answer this screen exists to stop.
 */

const CRON_PRESETS: ReadonlyArray<{ cron: string; label: string }> = [
  { cron: '0 3 * * 1-5', label: 'Weeknights' },
  { cron: '0 2 * * *', label: 'Nightly' },
  { cron: '0 * * * *', label: 'Hourly' },
  { cron: '*/15 * * * *', label: 'Every 15 min' },
  { cron: '0 6 * * 1', label: 'Monday morning' },
];

export function ScheduleDialog({
  open,
  onClose,
  onSubmit,
  existing,
  suites,
  environments,
  busy = false,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: ScheduleDraft) => void;
  /** Null for a new schedule. */
  existing: Schedule | null;
  suites: SuiteRef[];
  environments: EnvironmentRef[];
  busy?: boolean;
  error?: string | null;
}) {
  const [name, setName] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [cron, setCron] = useState('0 3 * * 1-5');
  const [timezone, setTimezone] = useState('UTC');

  /*
   * Reset on open, keyed on the subject as well as `open`. Reopening the dialog
   * on a different schedule while it is already mounted must not show the
   * previous one's cron — the mistake the PromptDialog note in ui/Field.tsx
   * documents, in a form with five fields instead of one.
   */
  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setSuiteId(existing?.suiteId ?? suites[0]?.id ?? '');
    setEnvironmentId(existing?.environmentId ?? environments[0]?.id ?? '');
    setCron(existing?.cron ?? '0 3 * * 1-5');
    setTimezone(existing?.timezone ?? browserTimeZone());
  }, [open, existing, suites, environments]);

  const cadence = useMemo(() => describeCron(cron), [cron]);
  // `new Date()` at render, not in the pure module: the offset is a fact about
  // right now and DST moves it twice a year.
  const zone = useMemo(() => formatZone(timezone, new Date()), [timezone]);
  const zones = useMemo(() => timeZoneOptions(timezone), [timezone]);

  const ready = name.trim().length > 0 && cron.trim().length > 0 && suiteId && environmentId;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Edit schedule' : 'New schedule'}
      description={
        existing
          ? undefined
          : 'A schedule runs one suite against one environment on a repeating clock — a nightly regression, a Monday-morning smoke test.'
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                suiteId,
                environmentId,
                cron: cron.trim(),
                timezone,
              })
            }
          >
            {existing ? 'Save schedule' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          data-autofocus
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nightly regression"
          maxLength={80}
        />

        <TargetFields
          suites={suites}
          environments={environments}
          suiteId={suiteId}
          environmentId={environmentId}
          onSuite={setSuiteId}
          onEnvironment={setEnvironmentId}
        />

        <div>
          <Field
            label="Cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * 1-5"
            className="font-mono"
            maxLength={120}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((preset) => (
              <button
                key={preset.cron}
                type="button"
                onClick={() => setCron(preset.cron)}
                className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-micro rounded-sm border px-2 py-[3px] font-mono tracking-[0.04em]"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <Picker
          label="Time zone"
          value={timezone}
          onChange={setTimezone}
          hint="the clock the schedule fires on"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Picker>

        {/* ── What was just described, said back ─────────────────────────── */}
        <div className="border-line bg-surface-2 rounded-lg border px-3.5 py-3">
          {cadence.kind === 'words' ? (
            <>
              <p className="text-ink text-body-sm">
                Runs <span className="font-semibold">{cadence.text}</span>
              </p>
              <p className="text-ink-faint text-micro mt-1 font-mono">
                {zone.valid
                  ? zone.text
                  : `${timezone} — the scheduler does not know this zone and will switch the schedule off`}
              </p>
            </>
          ) : (
            <>
              <p className="text-ink-dim text-body-sm">
                QAAI cannot put{' '}
                <span className="text-ink font-mono">{cadence.text || '(empty)'}</span> into
                words.
              </p>
              <p className="text-ink-faint text-micro mt-1 leading-relaxed">
                It is saved and run exactly as written — the scheduler will reject it on save if
                it cannot parse it. Only the plain-English summary is unavailable.
              </p>
            </>
          )}
        </div>

        {error && (
          <p
            role="alert"
            className="border-fail/40 text-fail text-row-sub rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
