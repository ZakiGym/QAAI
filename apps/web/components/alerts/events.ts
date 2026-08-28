/**
 * What QAAI pages about, and which of it a given channel hears.
 *
 * Pure on purpose: the web workspace has no jsdom, so the rules a screen must
 * get right live here as functions with tests, and the component below is left
 * with markup. Everything in this file MIRRORS the worker — the routing rules
 * are `wantsRunFinished` in apps/api/src/lib/chat-integrations.ts plus the
 * `monitor.down` branch of apps/worker/src/processors/notify.ts — and a mirror
 * is a liability, so it is written to be checkable at a glance rather than
 * clever. If a rule changes there, `routesTo` is the one place it changes here.
 *
 * The alternative was to show nothing about routing, which is what the product
 * did: a person could pick "failing runs only" once, at connect time, and had
 * no way to see or change what that actually meant afterwards.
 */

import type { NotifyPrefs, RunFinishedPref } from '../../lib/api';

/**
 * The events a channel can receive, in the order a person asks about them:
 * the ones that mean something is broken, then the ones that are a report.
 */
export type AlertEventId = 'monitor.down' | 'run.blocked' | 'run.failed' | 'run.passed' | 'digest';

export interface AlertEvent {
  id: AlertEventId;
  label: string;
  /** What actually fires it, in the product's own terms. */
  when: string;
}

export const ALERT_EVENTS: AlertEvent[] = [
  {
    id: 'monitor.down',
    label: 'A monitor goes down',
    when: 'a monitor fails its threshold number of checks in a row — the page, not a report',
  },
  {
    id: 'run.blocked',
    label: 'A quality gate blocks a run',
    when: 'a BLOCK rule crossed its threshold, which can happen with every test green',
  },
  {
    id: 'run.failed',
    label: 'A run fails',
    when: 'any finished run with at least one failed test',
  },
  {
    id: 'run.passed',
    label: 'A run passes',
    when: 'every finished run, green included — loud by design, and off by default',
  },
  { id: 'digest', label: 'The nightly digest', when: 'one summary per project per night' },
];

/**
 * `always` — this channel hears it whatever its preferences say.
 * `on` / `off` — the preference decides.
 */
export type Routing = 'always' | 'on' | 'off';

/**
 * Does `event` reach a channel with these preferences?
 *
 * A monitor page is `always` and that is not an oversight to be fixed in the
 * UI: the worker sends it to every enabled chat integration deliberately,
 * because `runFinished` is a preference about run REPORTS and a monitor going
 * down is not one. The screen says so out loud rather than rendering a control
 * that would silently do nothing.
 */
export function routesTo(event: AlertEventId, prefs: NotifyPrefs): Routing {
  switch (event) {
    case 'monitor.down':
      return 'always';
    case 'run.blocked':
    case 'run.failed':
      // `failures` and `all` both hear a run that failed or was blocked.
      return prefs.runFinished === 'off' ? 'off' : 'on';
    case 'run.passed':
      return prefs.runFinished === 'all' ? 'on' : 'off';
    case 'digest':
      return prefs.digest ? 'on' : 'off';
  }
}

/** The one-line answer to "what does this channel hear?", for the row header. */
export function routingSummary(prefs: NotifyPrefs): string {
  const runs =
    prefs.runFinished === 'off'
      ? 'monitor pages only'
      : prefs.runFinished === 'all'
        ? 'every run'
        : 'failures and blocked runs';
  return prefs.digest ? `${runs}, plus the digest` : runs;
}

/**
 * The body for PATCH /integrations/chat/:id — only what changed, or null when
 * nothing did.
 *
 * Null rather than `{}` because the endpoint's schema refuses an empty patch
 * with "nothing to update": a Save button that always fires would turn "I
 * changed my mind back" into an error message about a request the person never
 * meant to send. It is also what lets the button disable itself honestly.
 */
export function notifyPatch(
  current: NotifyPrefs,
  next: NotifyPrefs,
): { notify: Partial<NotifyPrefs> } | null {
  const notify: Partial<NotifyPrefs> = {};
  if (next.runFinished !== current.runFinished) notify.runFinished = next.runFinished;
  if (next.digest !== current.digest) notify.digest = next.digest;
  return Object.keys(notify).length === 0 ? null : { notify };
}

/** The labels for the run-report preference, as the choice actually reads. */
export const RUN_PREF_LABELS: Array<{ id: RunFinishedPref; label: string }> = [
  { id: 'failures', label: 'Failures and blocked runs' },
  { id: 'all', label: 'Every finished run, green included' },
  { id: 'off', label: 'Nothing about runs' },
];
