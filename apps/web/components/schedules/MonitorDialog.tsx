'use client';

import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { describeInterval } from './cadence';
import { TargetFields } from './pickers';
import type { EnvironmentRef, Monitor, MonitorDraft, SuiteRef } from './types';

/**
 * Create or edit a monitor.
 *
 * A monitor is NOT a schedule with a shorter cron, and this form is where that
 * has to be visible. It has no cron and no timezone — the worker simply
 * re-checks `intervalMinutes` after the last check, so it means the same thing
 * everywhere and there is no clock to name. What it has instead is a failure
 * threshold: the number of checks in a row that must fail before anybody is
 * paged. That field is the whole difference, so it gets the explanation.
 *
 * The threshold's floor of 1 is legal and deliberately discouraged in the hint
 * rather than blocked. A monitor that pages on a single blip is one people mute
 * within a week, and a muted monitor is worse than none — but somebody watching
 * a payment endpoint may genuinely want it, and the API allows it.
 */

const INTERVAL_PRESETS = [5, 15, 30, 60] as const;

export function MonitorDialog({
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
  onSubmit: (draft: MonitorDraft) => void;
  /** Null for a new monitor. */
  existing: Monitor | null;
  suites: SuiteRef[];
  environments: EnvironmentRef[];
  busy?: boolean;
  error?: string | null;
}) {
  const [name, setName] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [interval, setInterval] = useState('15');
  const [threshold, setThreshold] = useState('2');

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setSuiteId(existing?.suiteId ?? suites[0]?.id ?? '');
    setEnvironmentId(existing?.environmentId ?? environments[0]?.id ?? '');
    setInterval(String(existing?.intervalMinutes ?? 15));
    setThreshold(String(existing?.failureThreshold ?? 2));
  }, [open, existing, suites, environments]);

  /*
   * Held as strings so the fields can be empty mid-edit — a number-typed state
   * turns a cleared field into NaN and then into 0, and 0 is a value the API
   * refuses. Parsed once, here, with the API's own bounds.
   */
  const intervalMinutes = Number(interval);
  const failureThreshold = Number(threshold);
  const intervalOk = Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440;
  const thresholdOk =
    Number.isInteger(failureThreshold) && failureThreshold >= 1 && failureThreshold <= 10;

  const ready = name.trim().length > 0 && suiteId && environmentId && intervalOk && thresholdOk;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? 'Edit monitor' : 'New monitor'}
      description={
        existing
          ? undefined
          : 'A monitor re-runs a suite on a fixed interval and pages once it has failed a set number of times in a row.'
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
                intervalMinutes,
                failureThreshold,
              })
            }
          >
            {existing ? 'Save monitor' : 'Create monitor'}
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
          placeholder="Checkout uptime"
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
            label="Check every (minutes)"
            value={interval}
            inputMode="numeric"
            onChange={(e) => setInterval(e.target.value)}
            error={interval !== '' && !intervalOk ? 'Between 1 minute and 24 hours.' : null}
            hint={intervalOk ? describeInterval(intervalMinutes) : undefined}
            className="font-mono"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INTERVAL_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setInterval(String(minutes))}
                className="border-line text-ink-dim hover:text-ink hover:border-line-strong text-micro rounded-sm border px-2 py-[3px] font-mono tracking-[0.04em]"
              >
                {describeInterval(minutes)}
              </button>
            ))}
          </div>
        </div>

        <Field
          label="Alert after (consecutive failures)"
          value={threshold}
          inputMode="numeric"
          onChange={(e) => setThreshold(e.target.value)}
          error={threshold !== '' && !thresholdOk ? 'Between 1 and 10.' : null}
          hint={
            failureThreshold === 1
              ? 'Every single failure pages. One flaky test will train the team to ignore it.'
              : thresholdOk
                ? `${failureThreshold} failed checks in a row before anyone is paged.`
                : undefined
          }
          className="font-mono"
        />

        {existing && existing.consecutiveFailures > 0 && (
          <p className="text-ink-faint text-micro leading-relaxed">
            This monitor is currently on {existing.consecutiveFailures} consecutive failure
            {existing.consecutiveFailures === 1 ? '' : 's'}. Lowering the threshold below that
            restarts the count — the alert fires on the exact crossing, so a streak that has
            already passed the new threshold would otherwise never reach it again.
          </p>
        )}

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
