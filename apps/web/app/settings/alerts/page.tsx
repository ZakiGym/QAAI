'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type ChatIntegration } from '../../../lib/api';
import { ChannelAlerts } from '../../../components/alerts/ChannelAlerts';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Page, PageHeader, SectionLabel, SkeletonRows } from '../../../components/ui/layout';

/**
 * Alerts — what QAAI will wake you for, and who hears it.
 *
 * This screen exists because the routing was write-once: a channel's
 * preferences could be chosen at connect time on /integrations and never seen
 * or changed again, so "make #eng quieter" meant deleting the channel and
 * re-pasting its webhook URL. The PATCH has always been there; nothing called
 * it.
 *
 * It deliberately does NOT duplicate /integrations. Connecting a channel is a
 * credential-handling flow — a password field, a one-way seal, a disconnect
 * confirmation — and a second copy of it here would be a second copy to keep
 * correct. This screen owns the question that one does not answer: given the
 * channels you have, what reaches them.
 *
 * The test button lives on every row anyway. Verification belongs where the
 * configuration is; sending someone to another screen to find out whether the
 * thing they just changed still works is how integrations rot.
 */
export default function AlertsPage() {
  const router = useRouter();
  // null = not fetched yet. An error keeps it null, so the empty state's pitch
  // can never render over a list that merely failed to load.
  const [integrations, setIntegrations] = useState<ChatIntegration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { integrations } = await api<{ integrations: ChatIntegration[] }>('/integrations/chat');
      setIntegrations(integrations);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load the channels');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  // One source of truth for what is SAVED: the row keeps its own draft, and
  // hands back the server's row so the summary line and the Saved state come
  // from what the API stored rather than from what the form hoped it did.
  const replace = useCallback((updated: ChatIntegration) => {
    setIntegrations((rows) =>
      rows === null ? rows : rows.map((row) => (row.id === updated.id ? updated : row)),
    );
  }, []);

  return (
    <Page width="settings">
      <PageHeader
        eyebrow="Settings · Alerts"
        title="Alerts"
        size="sm"
        subtitle="Which failures reach a human, and where. Every message names the project, the environment, what broke and a link to the run."
      />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-row-sub mb-6 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
        >
          {error}
        </p>
      )}

      <section>
        <SectionLabel>Channels</SectionLabel>

        {integrations === null ? (
          !error && <SkeletonRows rows={2} />
        ) : integrations.length === 0 ? (
          <EmptyState
            title="Nothing would reach you"
            body="A monitor could go down at 3am and QAAI would have nowhere to say so. Connect a Slack, Teams or Discord incoming webhook — or a signed generic webhook — and come back here to choose what it hears."
            action={{ label: 'Connect a channel', href: '/integrations' }}
          />
        ) : (
          <div className="divide-line divide-y">
            {integrations.map((integration) => (
              <ChannelAlerts key={integration.id} integration={integration} onSaved={replace} />
            ))}
          </div>
        )}

        {integrations !== null && integrations.length > 0 && (
          <p className="text-ink-faint text-micro mt-4">
            Connecting or disconnecting a channel — and the delivery log that says whether each
            message actually landed — lives on{' '}
            <Link href="/integrations" className="text-accent hover:underline">
              Integrations
            </Link>
            .
          </p>
        )}
      </section>
    </Page>
  );
}
