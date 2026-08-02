'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  API_URL,
  api,
  ApiError,
  type GithubApp,
  type Integration,
} from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { useToast } from '../../../components/ui/Toast';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  Tabs,
} from '../../../components/ui/layout';

/**
 * The GitHub App — what QAAI is allowed to do inside your repositories.
 *
 * The screen is built around one refusal: never imply the product is broken
 * when it is merely un-installed. Without the app, pull-request feedback is
 * still delivered as a comment by the personal-access-token integration — so
 * this page checks whether that token actually exists and says which of the
 * three real situations you are in, rather than reciting a fallback that may
 * not be connected either.
 *
 * The configuration read-out is deliberately three separate facts. The API
 * reports `configured` as "App ID AND private key", and the failure everyone
 * hits is having one without the other: an App ID with no key looks configured
 * from the outside and posts nothing. Splitting the rows turns "the check never
 * appeared" into a two-minute diagnosis.
 */

interface Viewer {
  activeOrgId: string;
  orgs: Array<{ id: string; role: string }>;
}

interface RunLite {
  id: string;
  status: string;
  commitSha: string | null;
  prNumber: number | null;
  queuedAt: string;
}

const WEBHOOK_PATH = '/webhooks/github-app';

export default function GithubAppPage() {
  const router = useRouter();
  const toast = useToast();

  const [app, setApp] = useState<GithubApp | null>(null);
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reposting, setReposting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<GithubApp>('/github/app');
      setApp(data);
      setError(null);
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not read the GitHub App configuration');
    }
  }, [router]);

  useEffect(() => {
    void load();
    // The fallback claim is only honest if the token behind it exists.
    void api<{ integrations: Integration[] }>('/integrations')
      .then((d) => setIntegrations(d.integrations))
      .catch(() => setIntegrations([]));
    void api<{ runs: RunLite[] }>('/runs?limit=25')
      .then((d) => setRuns(d.runs))
      .catch(() => setRuns([]));
    void api<Viewer>('/auth/me')
      .then((me) => {
        const role = me.orgs.find((org) => org.id === me.activeOrgId)?.role;
        setCanManage(role === 'OWNER' || role === 'ADMIN');
      })
      .catch(() => setCanManage(false));
  }, [load]);

  async function repost(runId: string) {
    setReposting(runId);
    try {
      await api(`/github/checks/${runId}`, { method: 'POST' });
      toast.success('Queued. The check is re-derived from the run as it stands now.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not re-post the check');
    } finally {
      setReposting(null);
    }
  }

  const pat = integrations?.find((i) => i.kind === 'GITHUB' && i.hasToken && i.enabled) ?? null;
  const commitRuns = runs.filter((run) => run.commitSha);

  return (
    <Page width="wide">
      <PageHeader
        title="Infrastructure"
        subtitle="Where your tests execute, and what QAAI is allowed to touch."
      />

      <Tabs
        tabs={[
          { id: 'runners', label: 'Runners' },
          { id: 'github', label: 'GitHub App' },
        ]}
        active="github"
        onChange={(id) => {
          if (id === 'runners') router.push('/settings/runners');
        }}
      />

      {forbidden ? (
        <EmptyState
          title="Admins only"
          body="How this deployment's GitHub App is configured — its App ID, whether a private key loaded, which repositories it can act on — is visible to organization owners and admins. Ask one of them, or ask to be made an admin."
        />
      ) : error ? (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail text-body-sm rounded-md border p-3"
        >
          {error}
        </p>
      ) : !app ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="space-y-10">
          <Verdict app={app} pat={pat} loadingPat={integrations === null} />
          <Configuration app={app} />
          {!app.configured && <Setup />}
          <Repositories app={app} />
          {canManage && (
            <RepostChecks
              app={app}
              runs={commitRuns}
              busy={reposting}
              onRepost={(id) => void repost(id)}
            />
          )}
        </div>
      )}
    </Page>
  );
}

/**
 * The top line: what happens on a pull request today.
 *
 * Three genuinely different answers, and the third one is the one a product is
 * usually too embarrassed to print.
 */
function Verdict({
  app,
  pat,
  loadingPat,
}: {
  app: GithubApp;
  pat: Integration | null;
  loadingPat: boolean;
}) {
  const installed = app.projects.filter((p) => p.installed).length;

  if (app.configured) {
    return (
      <section className="border-pass/40 bg-pass/10 rounded-lg border p-4">
        <h2 className="text-sm font-medium">The GitHub App is configured on this deployment.</h2>
        <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">
          {installed > 0 ? (
            <>
              QAAI posts a check on pull requests for {installed} of your{' '}
              {app.projects.length} project{app.projects.length === 1 ? '' : 's'}, and a reviewer
              can re-run it from the merge box.
            </>
          ) : (
            <>
              It is not installed on any repository yet, so nothing is posted. Install it on the
              repositories below and checks start appearing on the next pull-request run.
            </>
          )}
          {!app.webhookConfigured && (
            <>
              {' '}
              The webhook secret is missing, so GitHub&apos;s events — including the re-run button —
              are refused rather than trusted.
            </>
          )}
        </p>
      </section>
    );
  }

  if (loadingPat) {
    return <Skeleton className="h-24 w-full" />;
  }

  if (pat) {
    return (
      <section className="border-line-strong bg-surface-1 rounded-lg border p-4">
        <h2 className="text-sm font-medium">
          No GitHub App here — pull-request feedback still arrives.
        </h2>
        <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">
          QAAI comments on the pull request using the access token connected to{' '}
          <code className="font-mono text-micro">{pat.repo}</code>, with the triage verdict for
          every failure. That path is working and needs nothing from you.
        </p>
        <p className="text-ink-dim text-body-sm mt-2 leading-relaxed">
          What the app would add is a <em>check</em>: a pass/fail entry in the merge box that a
          branch protection rule can require, and a re-run button a reviewer can press without
          leaving GitHub.
        </p>
      </section>
    );
  }

  return (
    <section className="border-flake/40 bg-flake/10 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Nothing is reported back to GitHub right now.</h2>
      <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">
        The app is not configured on this deployment, and no personal access token is connected
        either — so neither the check nor the fallback comment can be posted. Runs still record
        everything here; GitHub simply never hears about them.
      </p>
      <p className="text-ink-dim text-body-sm mt-2 leading-relaxed">
        The quickest fix is the token:{' '}
        <Link href="/source-control" className="text-accent hover:underline">
          connect a repository in Source control
        </Link>{' '}
        and pull requests start getting comments. The app, below, is the fuller version.
      </p>
    </section>
  );
}

/** The three facts, separately, because the half-configured case is the common one. */
function Configuration({ app }: { app: GithubApp }) {
  const keyLoaded = app.configured;
  const keyRow: { label: string; ok: boolean | null; value: string } = app.appId
    ? keyLoaded
      ? { label: 'Private key', ok: true, value: 'Loaded' }
      : {
          label: 'Private key',
          ok: false,
          value: 'Not set — the App ID is here but the key is not, so nothing can be signed',
        }
    : { label: 'Private key', ok: null, value: 'Not checked while there is no App ID' };

  return (
    <section>
      <SectionLabel>This deployment</SectionLabel>
      <Card className="divide-line divide-y">
        <ConfigRow
          label="App ID"
          ok={Boolean(app.appId)}
          value={app.appId ?? 'Not set'}
          mono={Boolean(app.appId)}
          note="Public — it appears in every token the app issues."
        />
        <ConfigRow label={keyRow.label} ok={keyRow.ok} value={keyRow.value} />
        <ConfigRow
          label="Webhook secret"
          ok={app.webhookConfigured}
          value={app.webhookConfigured ? 'Set' : 'Not set'}
          note={
            app.webhookConfigured
              ? 'Every event is verified against the raw bytes GitHub signed.'
              : 'Without it, inbound events are refused outright rather than trusted — installations and the re-run button will not work.'
          }
        />
        <ConfigRow
          label="Webhook URL"
          ok={null}
          value={`${API_URL}${WEBHOOK_PATH}`}
          mono
          note="Set this in the app's own settings on GitHub. It is the only path parsed raw, which is what makes signature checking possible."
        />
      </Card>
    </section>
  );
}

function ConfigRow({
  label,
  ok,
  value,
  mono,
  note,
}: {
  label: string;
  /** True = good, false = missing, null = not a pass/fail fact. */
  ok: boolean | null;
  value: string;
  mono?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          ok === null ? 'bg-skip' : ok ? 'bg-pass' : 'bg-fail'
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-body-sm w-28 shrink-0 font-medium">{label}</span>
          <span
            className={`text-body-sm text-ink-dim min-w-0 break-all ${mono ? 'font-mono' : ''}`}
          >
            {value}
          </span>
        </div>
        {note && <p className="text-ink-faint text-micro mt-1 leading-relaxed">{note}</p>}
      </div>
    </div>
  );
}

/** What has to happen, in the order it has to happen, with the real values in it. */
function Setup() {
  return (
    <section>
      <SectionLabel>Installing the app</SectionLabel>
      <Card className="p-4">
        <p className="text-ink-dim text-body-sm leading-relaxed">
          A GitHub App is created once per QAAI deployment, by whoever runs it — the values below
          are environment variables on the API, not settings this screen can write. That is
          deliberate: a private key that a web form could change is a private key anyone with a
          session can replace.
        </p>
        <ol className="text-body-sm text-ink-dim mt-4 space-y-3 leading-relaxed">
          <li>
            <span className="text-ink">1.</span>{' '}
            <a
              href="https://github.com/settings/apps/new"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Create the app on GitHub
            </a>{' '}
            (or under your organization&apos;s settings, if it should belong to the org). Give it{' '}
            <strong className="text-ink font-medium">Checks: write</strong> and{' '}
            <strong className="text-ink font-medium">Pull requests: read</strong> — nothing else is
            used.
          </li>
          <li>
            <span className="text-ink">2.</span>{' '}Set its webhook URL to{' '}
            <code className="border-line bg-surface text-micro rounded border px-1 py-0.5 font-mono">
              {API_URL}
              {WEBHOOK_PATH}
            </code>{' '}
            and subscribe it to{' '}
            <code className="font-mono text-micro">check_run</code>,{' '}
            <code className="font-mono text-micro">check_suite</code>,{' '}
            <code className="font-mono text-micro">installation</code> and{' '}
            <code className="font-mono text-micro">installation_repositories</code>.
          </li>
          <li>
            <span className="text-ink">3.</span>{' '}Put its App ID, private key and webhook secret on
            the API as{' '}
            <code className="font-mono text-micro">GITHUB_APP_ID</code>,{' '}
            <code className="font-mono text-micro">GITHUB_APP_PRIVATE_KEY</code> and{' '}
            <code className="font-mono text-micro">GITHUB_APP_WEBHOOK_SECRET</code>, then restart
            it. This page will say so.
          </li>
          <li>
            <span className="text-ink">4.</span>{' '}Install it on the repositories you want checks on.
            QAAI learns which those are from the installation event — it never guesses at a repo.
          </li>
        </ol>
        <p className="text-ink-faint text-micro mt-4 leading-relaxed">
          Until every one of those is done, nothing here is broken. Pull-request runs still execute
          and still record their results — what reaches GitHub today is at the top of this page.
        </p>
      </Card>
    </section>
  );
}

/** Which repositories the app can act on, project by project. */
function Repositories({ app }: { app: GithubApp }) {
  if (app.projects.length === 0) {
    return (
      <section>
        <SectionLabel>Repositories</SectionLabel>
        <EmptyState
          title="No projects yet"
          body="Repositories are matched to QAAI projects by their full name, so there is nothing to install the app on until you have added an app under test."
          action={{ label: 'Add app', href: '/onboarding' }}
        />
      </section>
    );
  }

  return (
    <section>
      <SectionLabel>Repositories</SectionLabel>
      <Card className="divide-line divide-y">
        {app.projects.map((project) => (
          <div key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <span className="text-body-sm font-medium">{project.name}</span>
            {project.repoFullName ? (
              <code className="text-ink-dim text-micro font-mono">{project.repoFullName}</code>
            ) : (
              <span className="text-ink-faint text-micro">no repository linked</span>
            )}
            <div className="ml-auto flex items-center gap-3">
              {!project.repoFullName ? (
                <Link href="/source-control" className="text-accent text-micro hover:underline">
                  Link a repository
                </Link>
              ) : project.installed ? (
                <Badge tone="pass">INSTALLED</Badge>
              ) : (
                <Badge tone="neutral">NOT INSTALLED</Badge>
              )}
            </div>
            {project.repoFullName && !project.installed && (
              <p className="text-ink-faint text-micro w-full leading-relaxed">
                {app.configured
                  ? 'The app has not been installed on this repository, so no check is posted for it. Install it from the app’s page on GitHub — QAAI records the installation when GitHub tells it about one.'
                  : 'Nothing to install yet — the app is not configured on this deployment.'}
              </p>
            )}
          </div>
        ))}
      </Card>
      {app.configured && (
        <p className="text-ink-faint text-micro mt-2 leading-relaxed">
          QAAI cannot link you straight to the install page: it knows the app&apos;s ID but not its
          public slug, and the slug is what that URL is built from. Your apps are under{' '}
          <a
            href="https://github.com/settings/apps"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            github.com/settings/apps
          </a>
          .
        </p>
      )}
    </section>
  );
}

/**
 * Re-post a check for one run — the escape hatch for "the check never appeared".
 *
 * Only runs with a commit SHA can have one: a check is attached to a commit, and
 * a manually triggered run against staging has no commit to attach to. Saying
 * that plainly is better than listing runs whose button would always fail.
 */
function RepostChecks({
  app,
  runs,
  busy,
  onRepost,
}: {
  app: GithubApp;
  runs: RunLite[];
  busy: string | null;
  onRepost: (runId: string) => void;
}) {
  return (
    <section>
      <SectionLabel>Re-post a check</SectionLabel>
      {!app.configured ? (
        <p className="text-ink-faint text-body-sm border-line rounded-lg border border-dashed p-4 leading-relaxed">
          There is no app to post a check with yet. Once one is configured, any run that came from a
          commit can have its check re-derived from here.
        </p>
      ) : runs.length === 0 ? (
        <p className="text-ink-faint text-body-sm border-line rounded-lg border border-dashed p-4 leading-relaxed">
          None of the last 25 runs came from a commit, so there is nothing on GitHub to attach a
          check to. Runs triggered by a push or a pull request appear here.
        </p>
      ) : (
        <Card className="divide-line divide-y">
          {runs.slice(0, 10).map((run) => (
            <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <Link
                href={`/runs/${run.id}`}
                className="text-accent text-body-sm font-mono hover:underline"
              >
                {run.id.slice(-8)}
              </Link>
              <code className="text-ink-dim text-micro font-mono">
                {run.commitSha?.slice(0, 7)}
              </code>
              {run.prNumber !== null && <Badge mono>PR #{run.prNumber}</Badge>}
              <span className="text-ink-faint text-micro">{run.status.toLowerCase()}</span>
              <Button
                size="sm"
                className="ml-auto"
                loading={busy === run.id}
                disabled={busy !== null && busy !== run.id}
                onClick={() => onRepost(run.id)}
              >
                Re-post check
              </Button>
            </div>
          ))}
        </Card>
      )}
      <p className="text-ink-faint text-micro mt-2 leading-relaxed">
        Re-posting updates the existing check rather than adding another, so it is safe to press
        twice.
      </p>
    </section>
  );
}
