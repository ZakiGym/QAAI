'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  type ChatIntegration,
  type ChatIntegrationKind,
  type ChatTestResult,
  type DeliveryStatus,
  type RunFinishedPref,
  type WebhookDelivery,
} from '../../lib/api';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { shortAgo } from '../../components/setup/time';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Badge, Page, SectionLabel, Skeleton, SkeletonRows } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Integrations (§7) — where notifications go, and whether they arrived.
 *
 * Two halves, deliberately on one screen. The rows are the org's chat and
 * webhook destinations — connect, test, disconnect. Under each row sits its
 * DELIVERY LOG, the read path over the attempts the worker records: this is
 * the screen that finally answers "did my Slack message go out?", and when the
 * answer is no, it says why in the same breath.
 *
 * The webhook URL is treated as what it is — a credential (the token is the
 * path). It goes into a password field, travels once, is sealed into the
 * vault, and comes back only as `host + last four characters`. No affordance
 * on this screen can get it back out.
 */

const KINDS: Array<{ id: ChatIntegrationKind; label: string; hint: string }> = [
  { id: 'SLACK', label: 'Slack', hint: 'https://hooks.slack.com/services/…' },
  { id: 'MSTEAMS', label: 'Teams', hint: 'https://….webhook.office.com/… or ….logic.azure.com/…' },
  { id: 'DISCORD', label: 'Discord', hint: 'https://discord.com/api/webhooks/…' },
  { id: 'WEBHOOK', label: 'Webhook', hint: 'https://your-receiver.example.com/qaai' },
];

/** The kind as the row's machine word. MSTEAMS reads as a hostname, not a product. */
const KIND_BADGE: Record<ChatIntegrationKind, string> = {
  SLACK: 'SLACK',
  MSTEAMS: 'TEAMS',
  DISCORD: 'DISCORD',
  WEBHOOK: 'WEBHOOK',
};

const RUN_PREFS: Array<{ id: RunFinishedPref; label: string }> = [
  { id: 'failures', label: 'Failing runs only' },
  { id: 'all', label: 'Every finished run, green included' },
  { id: 'off', label: 'Nothing about runs' },
];

/** The row's one-glance answer to "what does this channel hear?". */
function notifySummary(integration: ChatIntegration): string {
  const runs =
    integration.notify.runFinished === 'off'
      ? 'runs muted'
      : integration.notify.runFinished === 'all'
        ? 'all runs'
        : 'failures';
  return integration.notify.digest ? `${runs} + digest` : runs;
}

const STATUS_COLOR: Record<DeliveryStatus, string> = {
  SENT: 'text-pass',
  FAILED: 'text-fail',
  PENDING: 'text-flake',
};

export default function IntegrationsPage() {
  const router = useRouter();
  // null = not fetched yet. An error keeps it null — the empty state's "connect
  // one" pitch must never render over a list that simply failed to load.
  const [integrations, setIntegrations] = useState<ChatIntegration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Connect form, behind the `+ connect a channel` link.
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ChatIntegrationKind>('SLACK');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [runFinished, setRunFinished] = useState<RunFinishedPref>('failures');
  const [digest, setDigest] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Send test: the row in flight, and the last outcome per row. The outcome
  // stays on screen after the spinner goes — it IS the point of the button.
  const [testing, setTesting] = useState<string | null>(null);
  const [testOutcome, setTestOutcome] = useState<Record<string, ChatTestResult>>({});

  // The delivery log: one open at a time — it is a comparison within one
  // integration's attempts, not across integrations.
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // The integration awaiting a disconnect confirmation.
  const [pendingDelete, setPendingDelete] = useState<ChatIntegration | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { integrations } = await api<{ integrations: ChatIntegration[] }>('/integrations/chat');
      setIntegrations(integrations);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load the integrations');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDeliveries = useCallback(async (integrationId: string) => {
    setDeliveries(null);
    setLogError(null);
    try {
      const { deliveries } = await api<{ deliveries: WebhookDelivery[] }>(
        `/integrations/${integrationId}/deliveries`,
      );
      setDeliveries(deliveries);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : 'Could not load the delivery log');
    }
  }, []);

  function toggleLog(integrationId: string) {
    if (openLog === integrationId) {
      setOpenLog(null);
      return;
    }
    setOpenLog(integrationId);
    void loadDeliveries(integrationId);
  }

  async function sendTest(integration: ChatIntegration) {
    if (testing) return;
    setTesting(integration.id);
    try {
      const result = await api<ChatTestResult>(`/integrations/chat/${integration.id}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setTestOutcome((prev) => ({ ...prev, [integration.id]: result }));
    } catch (err) {
      // A 4xx here (no URL stored, envelope will not decrypt) is still an
      // outcome, and it is shown as one — never swallowed into a toast.
      setTestOutcome((prev) => ({
        ...prev,
        [integration.id]: {
          ok: false,
          responseStatus: null,
          error: err instanceof Error ? err.message : 'the test could not be sent',
          deliveryId: '',
        },
      }));
    } finally {
      setTesting(null);
    }
    // The test lands in the log too (sent or not) — refresh it if it is open.
    if (openLog === integration.id) void loadDeliveries(integration.id);
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (connecting || !name.trim() || !url.trim()) return;
    setConnecting(true);
    setFormError(null);
    try {
      await api('/integrations/chat', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          name: name.trim(),
          url: url.trim(),
          ...(kind === 'WEBHOOK' && secret ? { secret } : {}),
          notify: { runFinished, digest },
        }),
      });
      setName('');
      setUrl('');
      setSecret('');
      setAdding(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not connect the integration');
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(integration: ChatIntegration) {
    setDeleting(true);
    try {
      await api(`/integrations/${integration.id}`, { method: 'DELETE' });
      setPendingDelete(null);
      if (openLog === integration.id) setOpenLog(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect the integration');
    } finally {
      setDeleting(false);
    }
  }

  const showEmptyState = integrations !== null && integrations.length === 0 && !adding;

  return (
    <Page width="setup">
      <SetupHeader />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-row-sub mt-6 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
        >
          {error}
        </p>
      )}

      <section className="mt-7">
        <SectionLabel>Channels</SectionLabel>

        {integrations === null ? (
          !error && <SkeletonRows rows={3} />
        ) : showEmptyState ? (
          <EmptyState
            title="No channel is listening yet"
            body="Connect a Slack, Teams or Discord incoming webhook — or a signed generic webhook — and QAAI posts there when a run fails or a monitor goes down. Every attempt lands in a delivery log you can read, sent or not."
            action={{ label: 'Connect a channel', onClick: () => setAdding(true) }}
          />
        ) : (
          <div className="divide-line divide-y">
            {integrations.map((integration) => {
              const outcome = testOutcome[integration.id];
              const logOpen = openLog === integration.id;
              return (
                <div key={integration.id} className="py-3 first:pt-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    <Badge>{KIND_BADGE[integration.kind]}</Badge>
                    <span className="text-row font-semibold">{integration.name}</span>
                    <span className="text-ink-faint text-micro font-mono">
                      {integration.urlHint || integration.host}
                    </span>
                    <span className="text-ink-faint text-micro font-mono">
                      · {notifySummary(integration)}
                    </span>
                    {!integration.enabled && <Badge tone="flake">DISABLED</Badge>}
                    {!integration.hasUrl && <Badge tone="fail">NO URL</Badge>}
                    <span className="ml-auto flex items-center gap-3">
                      <Button
                        size="sm"
                        onClick={() => void sendTest(integration)}
                        loading={testing === integration.id}
                        disabled={testing !== null || !integration.hasUrl}
                      >
                        Send test
                      </Button>
                      <button
                        type="button"
                        onClick={() => toggleLog(integration.id)}
                        aria-expanded={logOpen}
                        className="text-accent text-[12px] hover:underline"
                      >
                        {logOpen ? 'hide deliveries' : 'deliveries'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(integration)}
                        className="text-ink-faint hover:text-fail text-[11.5px] transition-colors"
                      >
                        disconnect
                      </button>
                    </span>
                  </div>

                  {outcome && (
                    <p
                      role="status"
                      className={cn(
                        'text-micro mt-2 font-mono',
                        outcome.ok ? 'text-pass' : 'text-fail',
                      )}
                    >
                      {outcome.ok
                        ? `delivered — the provider answered HTTP ${outcome.responseStatus}`
                        : `not delivered — ${outcome.error ?? 'delivery failed'}`}
                    </p>
                  )}

                  {logOpen && <DeliveryLog rows={deliveries} error={logError} />}
                </div>
              );
            })}
          </div>
        )}

        {!showEmptyState && integrations !== null && (
          <p className="mt-3">
            <button
              type="button"
              onClick={() => setAdding((a) => !a)}
              aria-expanded={adding}
              className="text-accent text-[12px] hover:underline"
            >
              {adding ? '– cancel' : '+ connect a channel'}
            </button>
          </p>
        )}

        {adding && (
          <form onSubmit={connect} className="border-line mt-3 space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Integration kind">
              {KINDS.map((k) => (
                <Button
                  key={k.id}
                  size="sm"
                  aria-pressed={kind === k.id}
                  onClick={() => setKind(k.id)}
                  className={cn(kind === k.id && 'border-accent text-ink')}
                >
                  {k.label}
                </Button>
              ))}
            </div>
            <Field
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'WEBHOOK' ? 'ci-listener' : '#qa-alerts'}
            />
            <Field
              label="Webhook URL"
              type="password"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={KINDS.find((k) => k.id === kind)?.hint}
              autoComplete="off"
              className="font-mono"
              hint="the URL is the credential — sealed with AES-256-GCM, shown afterwards only as host + last 4"
            />
            {kind === 'WEBHOOK' && (
              <Field
                label="Signing secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="optional"
                autoComplete="off"
                hint="HMAC-SHA256 over each body, sent as x-qaai-signature-256 — lets your receiver verify the sender"
              />
            )}
            <div>
              <label
                htmlFor="notify-runs"
                className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
              >
                Send
              </label>
              <select
                id="notify-runs"
                value={runFinished}
                onChange={(e) => setRunFinished(e.target.value as RunFinishedPref)}
                className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
              >
                {RUN_PREFS.map((pref) => (
                  <option key={pref.id} value={pref.id}>
                    {pref.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="text-row-sub text-ink-dim flex items-center gap-2">
              <input
                type="checkbox"
                checked={digest}
                onChange={(e) => setDigest(e.target.checked)}
              />
              include the nightly digest
            </label>
            {formError && (
              <p role="alert" className="text-fail text-micro font-mono">
                {formError}
              </p>
            )}
            <Button type="submit" variant="primary" size="sm" loading={connecting}>
              Connect
            </Button>
          </form>
        )}
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void disconnect(pendingDelete);
        }}
        title={pendingDelete ? `Disconnect ${pendingDelete.name}?` : 'Disconnect'}
        body="The sealed webhook URL is deleted and nothing more is posted to this channel. Its delivery log goes with it."
        confirmLabel="Disconnect"
        busy={deleting}
      />
    </Page>
  );
}

/**
 * The read path over WebhookDelivery, one integration at a time.
 *
 * A log, so it is set as one: fixed mono columns the eye can scan without
 * reading — status word in its verdict colour, event, the provider's HTTP
 * answer, attempts, the last error, age. FAILED rows here are the product's
 * dead letter queue; the lastError column is why the row is in it.
 */
function DeliveryLog({ rows, error }: { rows: WebhookDelivery[] | null; error: string | null }) {
  return (
    <div className="border-line mt-3 rounded-lg border px-3.5 py-3">
      <h3 className="text-micro text-ink-faint mb-2 font-mono font-semibold tracking-[0.1em] uppercase">
        Delivery log
      </h3>
      {error ? (
        <p role="alert" className="text-fail text-micro font-mono">
          {error}
        </p>
      ) : rows === null ? (
        <div className="space-y-2" aria-label="Loading" role="status">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ink-faint text-micro">
          Nothing has been sent here yet. A failing run, a monitor alert, the nightly digest and
          the test button all land here — sent or not.
        </p>
      ) : (
        <div className="divide-line divide-y">
          {rows.map((delivery) => (
            <div key={delivery.id} className="text-micro flex items-baseline gap-3 py-1.5 font-mono">
              <span
                className={cn(
                  'w-14 shrink-0 font-semibold tracking-[0.05em]',
                  STATUS_COLOR[delivery.status],
                )}
              >
                {delivery.status}
              </span>
              <span className="text-ink-dim w-26 shrink-0 truncate" title={delivery.event}>
                {delivery.event}
              </span>
              <span className="text-ink-faint w-17 shrink-0 tabular-nums">
                {delivery.responseStatus !== null ? `HTTP ${delivery.responseStatus}` : '—'}
              </span>
              <span
                className="text-ink-faint w-8 shrink-0 tabular-nums"
                title={`${delivery.attempts} attempt${delivery.attempts === 1 ? '' : 's'}`}
              >
                ×{delivery.attempts}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  delivery.lastError ? 'text-fail' : 'text-ink-faint',
                )}
                title={delivery.lastError ?? undefined}
              >
                {delivery.lastError ?? ''}
              </span>
              <span className="text-ink-faint shrink-0 tabular-nums">
                {shortAgo(delivery.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
