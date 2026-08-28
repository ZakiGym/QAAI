'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { SECTION_TABS_SLOT_ID } from '../../../components/shell/AppShell';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { ConfirmDialog } from '../../../components/ui/Modal';
import { useToast } from '../../../components/ui/Toast';
import { Page, PageHeader, SectionLabel, SkeletonRows } from '../../../components/ui/layout';
import { InstallDialog } from '../../../components/plugins/InstallDialog';
import { PluginList } from '../../../components/plugins/PluginList';
import { PublisherList, TrustDialog } from '../../../components/plugins/PublisherList';
import type { InstalledPlugin, PluginRegistry, Publisher } from '../../../components/plugins/types';

/**
 * Plugins — whose code is allowed to run inside your test runs.
 *
 * Written for the person who has to answer for it. QAAI ships nineteen runner
 * plugins and reviews all of them; anything installed here QAAI has never seen,
 * and it will execute against the customer's application with the customer's
 * secrets in reach. So the screen is ordered by the question a reviewer asks,
 * not by the order things are done:
 *
 *   INSTALLED  what is here, what each one can reach, and — the part a registry
 *              usually leaves out — which projects it actually runs against.
 *              Installed and running are two different states and the row says
 *              which.
 *   TRUSTED    whose signatures we accept, by fingerprint. This is the root of
 *              the whole thing: nothing ships pre-trusted, so on a fresh
 *              organisation this list is empty and NOTHING can be installed.
 *
 * That order puts the consequence above the mechanism. Leading with publishers
 * would make the page read as a key-management screen with an installed list
 * underneath, and the question people actually arrive with is "what is running
 * in our pipeline".
 *
 * ─── The one thing this screen must never imply ──────────────────────────────
 *
 * That it verified anything. Signature checking happens on the server, against
 * a key that never leaves it. The install dialog says so in the panel where the
 * decision gets made, rather than in a footnote — see InstallDialog.
 */
export default function PluginsPage() {
  const toast = useToast();
  const [registry, setRegistry] = useState<PluginRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  /**
   * Whether to draw the controls at all.
   *
   * The API is the authority — every mutation here is ADMIN and a MEMBER's POST
   * comes back 403 whatever this says. Hiding the buttons is a courtesy, not a
   * control: offering somebody an Uninstall button that can only ever fail is
   * worse than not offering it, and this screen's read view is genuinely useful
   * on its own to the people whose runs execute the code.
   */
  const [canEdit, setCanEdit] = useState(false);

  const [installing, setInstalling] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<InstalledPlugin | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Publisher | null>(null);

  const load = useCallback(async () => {
    try {
      setRegistry(await api<PluginRegistry>('/plugins'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the plugin registry.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Only for the eyebrow: this page is a Settings tab and has to say whose
  // organisation's plugins these are, which /plugins does not carry.
  useEffect(() => {
    void api<{ activeOrgId: string; orgs: Array<{ id: string; name: string; role: string }> }>(
      '/auth/me',
    )
      .then((me) => {
        const active = me.orgs.find((org) => org.id === me.activeOrgId);
        setOrgName(active?.name ?? null);
        setCanEdit(active?.role === 'ADMIN' || active?.role === 'OWNER');
      })
      .catch(() => setOrgName(null));
  }, []);

  /**
   * One place every mutation goes through, so that the failure path is the same
   * everywhere: the server's own sentence, kept on screen until dismissed.
   *
   * That matters more here than on most screens. The refusals this API produces
   * are the product — "the signature does not match", "you have not trusted
   * this publisher", "the code you downloaded is not the code they signed" —
   * and replacing any of them with "install failed" would throw away the only
   * thing that tells the reader what to do next.
   */
  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setBusy(true);
      try {
        await work();
        await load();
        toast.success(success);
        return true;
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'That did not work.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, toast],
  );

  const install = useCallback(
    async (payload: {
      manifest: unknown;
      signature: { algorithm: string; value: string };
      bundleSha256: string;
    }) => {
      const ok = await run(
        () => api('/plugins', { method: 'POST', body: JSON.stringify(payload) }),
        'Installed. It runs nowhere until you enable it on a project.',
      );
      if (ok) setInstalling(false);
    },
    [run],
  );

  const trust = useCallback(
    async (input: { publisherId: string; displayName: string; publicKey: string }) => {
      const ok = await run(
        () => api('/plugins/publishers', { method: 'POST', body: JSON.stringify(input) }),
        `Trusted ${input.displayName}. Check the fingerprint against their own site.`,
      );
      if (ok) setTrusting(false);
    },
    [run],
  );

  const toggle = useCallback(
    async (plugin: InstalledPlugin, projectId: string, enabled: boolean) => {
      setPendingToggle(`${plugin.id}:${projectId}`);
      const project = registry?.projects.find((p) => p.id === projectId);
      await run(
        () =>
          api(`/plugins/${plugin.id}/projects/${projectId}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
          }),
        enabled
          ? `${plugin.name} now runs on ${project?.name ?? 'that project'}.`
          : `${plugin.name} no longer runs on ${project?.name ?? 'that project'}.`,
      );
      setPendingToggle(null);
    },
    [registry, run],
  );

  if (error) {
    return (
      <Shell orgName={orgName}>
        <p className="text-fail text-row-sub" role="alert">
          {error}
        </p>
      </Shell>
    );
  }

  if (!registry) {
    return (
      <Shell orgName={orgName}>
        <SkeletonRows rows={4} />
      </Shell>
    );
  }

  return (
    <Shell orgName={orgName}>
      <section>
        <div className="mb-2.5 flex items-end justify-between gap-4">
          <SectionLabel className="mb-0">Installed</SectionLabel>
          {canEdit && (
            <Button size="sm" onClick={() => setInstalling(true)}>
              Install a plugin
            </Button>
          )}
        </div>

        {registry.plugins.length === 0 ? (
          <EmptyState
            title="No third-party plugins"
            body={
              registry.publishers.length === 0
                ? 'QAAI’s own nineteen plugins are always available. Anything else has to be signed by a publisher you have trusted below — and you have not trusted anybody yet, so nothing can be installed.'
                : 'QAAI’s own nineteen plugins are always available. Anything else has to be signed by one of the publishers you trust, and is checked on install.'
            }
            {...(canEdit
              ? {
                  action:
                    registry.publishers.length === 0
                      ? { label: 'Trust a publisher', onClick: () => setTrusting(true) }
                      : { label: 'Install a plugin', onClick: () => setInstalling(true) },
                }
              : {})}
          />
        ) : (
          <PluginList
            plugins={registry.plugins}
            projects={registry.projects}
            vocabulary={registry.capabilities}
            onToggle={toggle}
            onUninstall={setConfirmUninstall}
            canEdit={canEdit}
            pending={pendingToggle}
          />
        )}
      </section>

      <section className="mt-10">
        <div className="mb-2.5 flex items-end justify-between gap-4">
          <SectionLabel className="mb-0">Trusted publishers</SectionLabel>
          {canEdit && (
            <Button size="sm" onClick={() => setTrusting(true)}>
              Trust a publisher
            </Button>
          )}
        </div>

        {registry.publishers.length === 0 ? (
          <EmptyState
            title="You trust nobody yet"
            body="A plugin is only installable if it is signed by a key on this list. Get the key from the publisher directly — not from the page offering the download — and compare the fingerprint we show you against what they publish."
            {...(canEdit
              ? { action: { label: 'Trust a publisher', onClick: () => setTrusting(true) } }
              : {})}
          />
        ) : (
          <PublisherList
            publishers={registry.publishers}
            onRevoke={setConfirmRevoke}
            canEdit={canEdit}
          />
        )}
      </section>

      <p className="text-ink-faint text-micro mt-10 leading-relaxed">
        This build speaks plugin protocol {registry.protocol.speaks} (oldest honoured:{' '}
        {registry.protocol.oldest}). Your plan is {registry.plan.label}
        {registry.plan.allowsGovernedCapabilities
          ? ', which can grant every capability.'
          : ', which cannot grant capabilities that need the audit log — the workspace, the worker’s environment, project secrets, or running commands.'}
      </p>

      <InstallDialog
        open={installing}
        onClose={() => setInstalling(false)}
        registry={registry}
        onInstall={install}
        busy={busy}
      />

      <TrustDialog
        open={trusting}
        onClose={() => setTrusting(false)}
        onTrust={trust}
        busy={busy}
      />

      <ConfirmDialog
        open={confirmUninstall !== null}
        onClose={() => setConfirmUninstall(null)}
        busy={busy}
        title={`Uninstall ${confirmUninstall?.name ?? ''}?`}
        // Names the projects, because this is the sentence that decides whether
        // somebody's nightly suite changes behaviour tonight.
        body={
          confirmUninstall
            ? `It stops running immediately on ${
                registry.projects
                  .filter((p) => confirmUninstall.projects[p.id] === true)
                  .map((p) => p.name)
                  .join(', ') || 'no projects — it is not enabled anywhere'
              }. Reinstalling means pasting the signed manifest again.`
            : ''
        }
        confirmLabel="Uninstall"
        onConfirm={() => {
          const plugin = confirmUninstall;
          if (!plugin) return;
          void run(
            () => api(`/plugins/${plugin.id}`, { method: 'DELETE' }),
            `Uninstalled ${plugin.name}.`,
          ).then(() => setConfirmUninstall(null));
        }}
      />

      <ConfirmDialog
        open={confirmRevoke !== null}
        onClose={() => setConfirmRevoke(null)}
        busy={busy}
        title={`Revoke ${confirmRevoke?.displayName ?? ''}’s key?`}
        /*
         * Says what revoking does NOT do, and that is the point. Revoking is
         * about future installs; it deliberately leaves what is already
         * installed running, because one click that silently stops several
         * suites is not a decision anybody made on this screen. The list marks
         * those plugins afterwards.
         */
        body={
          confirmRevoke
            ? `Nothing signed by that key can be installed again. The ${confirmRevoke.pluginCount} plugin${
                confirmRevoke.pluginCount === 1 ? '' : 's'
              } already installed under it keep running and are marked above — uninstall them separately if that is what you mean.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={() => {
          const publisher = confirmRevoke;
          if (!publisher) return;
          void run(
            () => api(`/plugins/publishers/${publisher.id}/revoke`, { method: 'POST' }),
            `Revoked ${publisher.displayName}’s key.`,
          ).then(() => setConfirmRevoke(null));
        }}
      />
    </Shell>
  );
}

/** The Settings chrome, so the three render states share one header. */
function Shell({ orgName, children }: { orgName: string | null; children: React.ReactNode }) {
  return (
    <Page width="settings">
      <PageHeader
        // A non-breaking space while the org name is in flight, so the title
        // does not jump down a line when it lands.
        eyebrow={orgName ? `${orgName} · Settings` : ' '}
        title="Settings"
      />
      {/* The shell portals the section strip in here, under the title. */}
      <div id={SECTION_TABS_SLOT_ID} />
      <div className="mt-[26px]">{children}</div>
    </Page>
  );
}
