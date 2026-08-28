'use client';

import { useState } from 'react';
import {
  api,
  type ChatIntegration,
  type ChatTestResult,
  type RunFinishedPref,
} from '../../lib/api';
import { Button } from '../ui/Button';
import { Badge } from '../ui/layout';
import { cn } from '../../lib/cn';
import {
  ALERT_EVENTS,
  RUN_PREF_LABELS,
  notifyPatch,
  routesTo,
  routingSummary,
  type Routing,
} from './events';

/**
 * One channel, and what it will wake someone for.
 *
 * The routing table redraws from the DRAFT preference, not the saved one, so
 * the consequence of a choice is visible before it is saved — "every finished
 * run, green included" reads as a sentence, but seeing `A run passes` flip to
 * `sends` is what stops someone subscribing a channel to a firehose and muting
 * it a week later.
 *
 * The test button is on this row rather than a page of its own for the same
 * reason: an integration you cannot test where you configured it is one people
 * set up wrong and find out about at 3am. Its outcome stays on screen after
 * the spinner goes — the outcome IS the point of pressing it.
 */

const KIND_BADGE: Record<ChatIntegration['kind'], string> = {
  SLACK: 'SLACK',
  MSTEAMS: 'TEAMS',
  DISCORD: 'DISCORD',
  WEBHOOK: 'WEBHOOK',
};

/** The word in the routing table, and the colour it is said in. */
const ROUTING_WORD: Record<Routing, { label: string; className: string }> = {
  always: { label: 'always', className: 'text-pass' },
  on: { label: 'sends', className: 'text-pass' },
  off: { label: 'silent', className: 'text-ink-faint' },
};

export function ChannelAlerts({
  integration,
  onSaved,
}: {
  integration: ChatIntegration;
  /** Lets the page hold one source of truth for the saved preferences. */
  onSaved: (updated: ChatIntegration) => void;
}) {
  const [runFinished, setRunFinished] = useState<RunFinishedPref>(integration.notify.runFinished);
  const [digest, setDigest] = useState(integration.notify.digest);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<ChatTestResult | null>(null);

  const draft = { runFinished, digest };
  const patch = notifyPatch(integration.notify, draft);

  async function save() {
    // Guarded by the button being disabled too; this is the guard that survives
    // a double-submit, and it is why notifyPatch returns null rather than {}.
    if (!patch || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { integration: updated } = await api<{ integration: ChatIntegration }>(
        `/integrations/chat/${integration.id}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save what this channel hears');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (testing) return;
    setTesting(true);
    try {
      setOutcome(
        await api<ChatTestResult>(`/integrations/chat/${integration.id}/test`, {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    } catch (err) {
      // A 4xx here — no URL stored, an envelope that will not decrypt — is
      // still an outcome, and is shown as one rather than swallowed.
      setOutcome({
        ok: false,
        responseStatus: null,
        error: err instanceof Error ? err.message : 'the test could not be sent',
        deliveryId: '',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="py-4 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Badge>{KIND_BADGE[integration.kind]}</Badge>
        <span className="text-row font-semibold">{integration.name}</span>
        {/* host + last four of the path. The URL is the credential and no
            affordance on this screen can get it back out. */}
        <span className="text-ink-faint text-micro font-mono">
          {integration.urlHint || integration.host}
        </span>
        {!integration.enabled && <Badge tone="flake">DISABLED</Badge>}
        {!integration.hasUrl && <Badge tone="fail">NO URL</Badge>}
        <span className="ml-auto">
          <Button
            size="sm"
            onClick={() => void sendTest()}
            loading={testing}
            disabled={!integration.hasUrl}
          >
            Send test
          </Button>
        </span>
      </div>

      <p className="text-ink-dim text-micro mt-1 font-mono">
        currently: {routingSummary(integration.notify)}
      </p>

      {outcome && (
        <p
          role="status"
          className={cn('text-micro mt-2 font-mono', outcome.ok ? 'text-pass' : 'text-fail')}
        >
          {outcome.ok
            ? `delivered — the provider answered HTTP ${outcome.responseStatus}`
            : `not delivered — ${outcome.error ?? 'delivery failed'}`}
        </p>
      )}

      <div className="border-line mt-3 rounded-lg border px-3.5 py-3">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="min-w-56 flex-1">
            <label
              htmlFor={`runs-${integration.id}`}
              className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
            >
              Run reports
            </label>
            <select
              id={`runs-${integration.id}`}
              value={runFinished}
              onChange={(e) => setRunFinished(e.target.value as RunFinishedPref)}
              className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
            >
              {RUN_PREF_LABELS.map((pref) => (
                <option key={pref.id} value={pref.id}>
                  {pref.label}
                </option>
              ))}
            </select>
          </div>
          <label className="text-row-sub text-ink-dim flex items-center gap-2 pb-2">
            <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
            the nightly digest
          </label>
          <Button
            variant="primary"
            size="sm"
            className="mb-1"
            onClick={() => void save()}
            loading={saving}
            disabled={patch === null}
          >
            {patch === null ? 'Saved' : 'Save'}
          </Button>
        </div>

        <ul className="mt-3.5 space-y-1">
          {ALERT_EVENTS.map((event) => {
            const routing = ROUTING_WORD[routesTo(event.id, draft)];
            return (
              <li key={event.id} className="text-micro flex items-baseline gap-3 font-mono">
                <span className={cn('w-14 shrink-0 font-semibold', routing.className)}>
                  {routing.label}
                </span>
                <span className="text-ink-dim w-52 shrink-0">{event.label}</span>
                <span className="text-ink-faint min-w-0 flex-1">{event.when}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {error && (
        <p role="alert" className="text-fail text-micro mt-2 font-mono">
          {error}
        </p>
      )}
    </div>
  );
}
