'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  API_URL,
  api,
  ApiError,
  type MintedRunner,
  type Runner,
  type RunnerJob,
} from '../../../lib/api';
import { RunnerList, elapsed, heldJobsFor } from '../../../components/RunnerList';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Field } from '../../../components/ui/Field';
import { ConfirmDialog, Modal } from '../../../components/ui/Modal';
import { useToast } from '../../../components/ui/Toast';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  SkeletonRows,
  Tabs,
} from '../../../components/ui/layout';

/**
 * Runners — the machines inside your network that execute your suite.
 *
 * Written for the person who has to justify pointing a vendor's agent at their
 * staging environment, so the screen's job is evidence rather than reassurance:
 * when we last heard from each host, what it says it can do, what it is holding
 * right now, and what is stuck in the queue with the reason attached.
 *
 * Two things here are irreversible and both are treated as such. A token is
 * shown exactly once because the server keeps only its hash — so the reveal is
 * a banner you dismiss deliberately, not a modal a stray Escape can eat.
 * Revoking cuts a runner off mid-job, so the confirmation names the run it is
 * holding and says where that work goes.
 */

/** Just enough of GET /auth/me to know whether the mutations will be allowed. */
interface Viewer {
  activeOrgId: string;
  orgs: Array<{ id: string; role: string }>;
}

/** Refresh cadence. Liveness is a clock reading; a stale one is the bug. */
const POLL_MS = 10_000;

type PendingAction = { kind: 'rotate' | 'revoke'; runner: Runner } | null;

export default function RunnersPage() {
  const router = useRouter();
  const toast = useToast();

  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [jobs, setJobs] = useState<RunnerJob[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState('');
  const [pools, setPools] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  /** The token, alive only in this tab's memory and only until dismissed. */
  const [minted, setMinted] = useState<{ token: string; name: string; rotated: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const [fleet, queue] = await Promise.all([
        api<{ runners: Runner[] }>('/runners'),
        // The queue sweep runs when this is fetched, which is how an org with
        // no runner left ever learns its jobs are unservable.
        api<{ jobs: RunnerJob[] }>('/runners/queue').catch(() => ({ jobs: [] as RunnerJob[] })),
      ]);
      setRunners(fleet.runners);
      setJobs(queue.jobs);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      setRunners([]);
      setError(err instanceof Error ? err.message : 'Could not load runners');
    }
  }, [router]);

  useEffect(() => {
    void load();
    void api<Viewer>('/auth/me')
      .then((me) => {
        const role = me.orgs.find((org) => org.id === me.activeOrgId)?.role;
        setCanManage(role === 'OWNER' || role === 'ADMIN');
      })
      .catch(() => setCanManage(false));
  }, [load]);

  // Poll, because "online" is a statement about the last sixty seconds and a
  // screen that froze at page load would keep asserting it forever.
  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function register() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await api<MintedRunner>('/runners', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          pools: pools
            .split(',')
            .map((pool) => pool.trim())
            .filter(Boolean),
        }),
      });
      setMinted({ token: result.token, name: result.runner.name, rotated: false });
      setName('');
      setPools('');
      setRegistering(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not register the runner');
    } finally {
      setBusy(false);
    }
  }

  async function rotate(runner: Runner) {
    setBusyId(runner.id);
    try {
      const result = await api<MintedRunner>(`/runners/${runner.id}/rotate`, { method: 'POST' });
      setMinted({ token: result.token, name: runner.name, rotated: true });
      setPending(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rotate the token');
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(runner: Runner) {
    setBusyId(runner.id);
    try {
      const { releasedJobs } = await api<{ ok: boolean; releasedJobs: number }>(
        `/runners/${runner.id}`,
        { method: 'DELETE' },
      );
      toast.success(
        releasedJobs === 0
          ? `${runner.name} is revoked. It was holding no work.`
          : `${runner.name} is revoked. ${releasedJobs} job${
              releasedJobs === 1 ? '' : 's'
            } went back to the queue.`,
      );
      setPending(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revoke the runner');
    } finally {
      setBusyId(null);
    }
  }

  const queue = useMemo(() => groupQueue(jobs), [jobs]);
  const loading = runners === null;

  return (
    <Page width="wide">
      <PageHeader
        title="Infrastructure"
        subtitle="Where your tests execute, and what QAAI is allowed to touch."
      />

      <Tabs
        tabs={[
          { id: 'runners', label: 'Runners', count: runners?.length },
          { id: 'github', label: 'GitHub App' },
        ]}
        active="runners"
        onChange={(id) => {
          if (id === 'github') router.push('/settings/github');
        }}
      />

      <div className="mb-6 flex items-start gap-4">
        <p className="text-ink-dim text-body-sm min-w-0 flex-1 leading-relaxed">
          A runner executes your suite on a host you control, so QAAI never needs to reach your
          staging network. The agent only ever dials out — there is nothing to open inbound, and it
          runs the executor named in its own local config, never a command from us.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
          {canManage && (
            <Button variant="primary" size="sm" onClick={() => setRegistering(true)}>
              Register runner
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="border-fail/40 bg-fail/10 text-fail text-body-sm mb-6 rounded-md border p-3"
        >
          {error}
        </p>
      )}

      {minted && (
        <TokenBanner
          token={minted.token}
          name={minted.name}
          rotated={minted.rotated}
          onDismiss={() => setMinted(null)}
        />
      )}

      {loading ? (
        <Card className="overflow-hidden">
          <SkeletonRows rows={3} />
        </Card>
      ) : runners.length === 0 ? (
        <EmptyState
          title="No runners registered"
          body="Your suite runs on QAAI's own workers today. Register a runner to execute it inside your network instead — on a host that can already reach the application under test."
          action={
            canManage
              ? { label: 'Register runner', onClick: () => setRegistering(true) }
              : undefined
          }
        />
      ) : (
        <RunnerList
          runners={runners}
          jobs={jobs}
          canManage={canManage}
          busyId={busyId}
          now={now}
          onRotate={(runner) => setPending({ kind: 'rotate', runner })}
          onRevoke={(runner) => setPending({ kind: 'revoke', runner })}
        />
      )}

      {!canManage && !loading && (
        <p className="text-ink-faint text-micro mt-3">
          Registering, rotating and revoking runners is limited to organization admins.
        </p>
      )}

      {!loading && (runners.length > 0 || jobs.length > 0) && (
        <QueueSection queue={queue} now={now} />
      )}

      {!loading && <StartAgentHelp />}

      {/* ── Register ────────────────────────────────────────────────────── */}
      <Modal
        open={registering}
        onClose={() => setRegistering(false)}
        title="Register a runner"
        description="This mints a token. You will see it once."
        footer={
          <>
            <Button onClick={() => setRegistering(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void register()} loading={busy}>
              Register and mint token
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            data-autofocus
            label="Name"
            hint="How this host is known to you — it appears in run logs and the audit trail."
            placeholder="build-host-01"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void register();
              }
            }}
          />
          <Field
            label="Pools (optional)"
            hint="Comma separated. A pool routes work to a network segment; an environment names the pool it must run in. Leave blank for the default pool."
            placeholder="eu-staging, gpu"
            value={pools}
            onChange={(e) => setPools(e.target.value)}
          />
          <p className="text-ink-faint text-micro leading-relaxed">
            A runner cannot choose its own pool — an agent that could would be able to pull work
            meant for a different network. That decision stays here.
          </p>
        </div>
      </Modal>

      {/* ── Rotate / revoke ─────────────────────────────────────────────── */}
      <ConfirmDialog
        open={pending?.kind === 'rotate'}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending?.kind === 'rotate') void rotate(pending.runner);
        }}
        title={pending ? `Rotate the token for ${pending.runner.name}?` : 'Rotate token'}
        body={pending ? rotateBody(pending.runner, heldJobsFor(jobs, pending.runner.id)) : ''}
        confirmLabel="Rotate token"
        tone="primary"
        busy={busyId !== null}
      />

      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending?.kind === 'revoke') void revoke(pending.runner);
        }}
        title={pending ? `Revoke ${pending.runner.name}?` : 'Revoke runner'}
        body={pending ? revokeBody(heldJobsFor(jobs, pending.runner.id)) : ''}
        confirmLabel="Revoke runner"
        busy={busyId !== null}
      />
    </Page>
  );
}

/**
 * What rotation actually costs, named before it happens.
 *
 * There is no overlap window by design — the reason to rotate is usually that
 * the old value leaked — so the agent breaks until someone pastes the new one.
 */
function rotateBody(runner: Runner, held: RunnerJob[]): string {
  const work =
    held.length === 0
      ? 'It is holding no work right now, so nothing is interrupted.'
      : `It is holding ${held.length} job${held.length === 1 ? '' : 's'} right now (run${
          held.length === 1 ? ` ${held[0]!.runId.slice(-8)}` : 's'
        }); ${held.length === 1 ? 'it goes' : 'they go'} straight back to the queue for another runner and the tests in ${
          held.length === 1 ? 'it' : 'them'
        } start again from the beginning.`;
  return `The current token stops working the moment this returns, so the agent on ${runner.name} will fail its next call until you paste the new one. ${work} The new token is shown once and never again.`;
}

function revokeBody(held: RunnerJob[]): string {
  const work =
    held.length === 0
      ? 'It is holding no work right now, so no run is interrupted.'
      : `It is holding ${held.length} job${held.length === 1 ? '' : 's'} right now — ${held
          .map(
            (job) =>
              `run ${job.runId.slice(-8)}${
                job.shardIndex === null ? '' : ` shard ${job.shardIndex}`
              }`,
          )
          .join(', ')}. That work goes straight back to the queue. If no other online runner can serve it, QAAI skips it fifteen minutes after it was queued and every test in it reports as SKIPPED — not failed — so the run finishes with those tests unexecuted.`;
  return `Its token stops working immediately and it disappears from this list. ${work} Results it has already reported are kept, and the audit trail still names it for every job it ever ran.`;
}

/**
 * The token, once.
 *
 * A banner rather than a dialog on purpose: Escape closes a dialog, and losing
 * the only copy of a credential to a keystroke is not a recoverable mistake —
 * it costs a rotation and a visit to the host.
 */
function TokenBanner({
  token,
  name,
  rotated,
  onDismiss,
}: {
  token: string;
  name: string;
  rotated: boolean;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="border-accent/50 bg-accent/10 mb-6 rounded-lg border p-4" role="status">
      <h2 className="text-sm font-medium">
        {rotated ? `New token for ${name}` : `${name} is registered`}
      </h2>
      <p className="text-ink-dim text-body-sm mt-1 leading-relaxed">
        Copy this now. QAAI stores only a hash of it, so this is the only time it can ever be
        shown — if it is lost, the way back is to rotate the runner and visit the host again.
      </p>
      <code className="border-line bg-surface text-body-sm mt-3 block overflow-x-auto rounded border px-3 py-2 font-mono">
        {token}
      </code>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(token);
            setCopied(true);
          }}
        >
          Copy token
        </Button>
        <Button size="sm" onClick={onDismiss}>
          {copied ? 'Done — hide it' : 'Dismiss without copying'}
        </Button>
        {copied && <span className="text-pass text-micro">Copied to your clipboard.</span>}
      </div>
      <p className="text-ink-faint text-micro mt-3 leading-relaxed">
        On the host:{' '}
        <code className="font-mono">export QAAI_RUNNER_TOKEN=&apos;…&apos;</code> then{' '}
        <code className="font-mono">qaai runner --api-url {API_URL}</code>. Keep it out of the
        command line — anything on a process&apos;s argv is readable by every other process on that
        box; <code className="font-mono">--token-file</code> exists for that reason.
      </p>
    </div>
  );
}

// ─── The queue ───────────────────────────────────────────────────────────────

interface Queue {
  inFlight: RunnerJob[];
  waiting: RunnerJob[];
  attention: RunnerJob[];
  completed: number;
}

/**
 * The queue is only interesting in three of its eight states.
 *
 * COMPLETED is a count, because a hundred green rows push the one ABANDONED job
 * off the screen — and that job is the entire reason anyone opened this.
 */
function groupQueue(jobs: RunnerJob[]): Queue {
  return {
    inFlight: jobs.filter((job) => job.status === 'CLAIMED' || job.status === 'RUNNING'),
    waiting: jobs.filter((job) => job.status === 'QUEUED'),
    attention: jobs.filter(
      (job) =>
        job.status === 'ABANDONED' ||
        job.status === 'SKIPPED' ||
        job.status === 'FAILED' ||
        job.status === 'CANCELLED',
    ),
    completed: jobs.filter((job) => job.status === 'COMPLETED').length,
  };
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'pass' | 'fail' | 'flake'> = {
  QUEUED: 'neutral',
  CLAIMED: 'accent',
  RUNNING: 'accent',
  COMPLETED: 'pass',
  FAILED: 'fail',
  ABANDONED: 'fail',
  CANCELLED: 'neutral',
  SKIPPED: 'flake',
};

function QueueSection({ queue, now }: { queue: Queue; now: number }) {
  const nothing =
    queue.inFlight.length === 0 && queue.waiting.length === 0 && queue.attention.length === 0;

  return (
    <section className="mt-10">
      <SectionLabel>On-prem queue</SectionLabel>
      {nothing ? (
        <p className="text-ink-faint text-body-sm border-line rounded-lg border border-dashed p-4 leading-relaxed">
          Nothing is queued for an on-prem pool.
          {queue.completed > 0 && (
            <> The last {queue.completed} on-prem jobs finished without incident. </>
          )}{' '}
          Work only arrives here when an environment names a runner pool — otherwise runs go to
          QAAI&apos;s own workers.
        </p>
      ) : (
        <div className="space-y-5">
          {queue.attention.length > 0 && (
            <QueueGroup
              title="Needs attention"
              note="These jobs will not execute another test. The sentence on each is the one written into the run."
              jobs={queue.attention}
              now={now}
            />
          )}
          {queue.inFlight.length > 0 && (
            <QueueGroup title="In flight" jobs={queue.inFlight} now={now} />
          )}
          {queue.waiting.length > 0 && (
            <QueueGroup
              title="Waiting for a runner"
              note="A job that no online runner can serve is skipped fifteen minutes after it was queued, rather than waiting forever — the tests in it report as skipped."
              jobs={queue.waiting}
              now={now}
            />
          )}
          {queue.completed > 0 && (
            <p className="text-ink-faint text-micro tabular-nums">
              {queue.completed} completed job{queue.completed === 1 ? '' : 's'} in the last 200.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function QueueGroup({
  title,
  note,
  jobs,
  now,
}: {
  title: string;
  note?: string;
  jobs: RunnerJob[];
  now: number;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-body-sm font-medium">{title}</h3>
        <span className="text-ink-faint text-micro tabular-nums">{jobs.length}</span>
      </div>
      {note && <p className="text-ink-faint text-micro mb-2 leading-relaxed">{note}</p>}
      <Card className="divide-line divide-y overflow-hidden">
        {jobs.slice(0, 25).map((job) => (
          <div key={job.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status}</Badge>
              <Link
                href={`/runs/${job.runId}`}
                className="text-accent text-body-sm font-mono hover:underline"
              >
                {job.runId.slice(-8)}
              </Link>
              <span className="text-ink-dim text-body-sm">
                {job.shardIndex === null ? 'whole run' : `shard ${job.shardIndex}`}
              </span>
              {job.pool && <Badge mono>{job.pool}</Badge>}
              {job.attempt > 1 && (
                <span className="text-flake text-micro tabular-nums">
                  attempt {job.attempt} of {job.maxAttempts}
                </span>
              )}
              <span className="text-ink-faint text-micro ml-auto tabular-nums">
                {job.status === 'QUEUED'
                  ? `waiting ${elapsed(job.queuedAt, now)}`
                  : job.finishedAt
                    ? `${elapsed(job.finishedAt, now)} ago`
                    : job.claimedAt
                      ? `picked up ${elapsed(job.claimedAt, now)} ago`
                      : `queued ${elapsed(job.queuedAt, now)} ago`}
              </span>
            </div>
            {job.errorMessage && (
              <p className="text-ink-dim text-micro mt-1.5 leading-relaxed">{job.errorMessage}</p>
            )}
            <Requirements requirements={job.requirements} />
          </div>
        ))}
      </Card>
    </div>
  );
}

/** What a runner must have before this job can be offered to it. */
function Requirements({ requirements }: { requirements: RunnerJob['requirements'] }) {
  const parts = [
    ...(requirements.testTypes ?? []),
    ...(requirements.browsers ?? []),
    ...(requirements.toolchains ?? []),
  ];
  if (parts.length === 0) return null;
  return (
    <p className="text-ink-faint text-meta mt-1 font-mono">needs {parts.join(' · ')}</p>
  );
}

/** How to actually start one — the screen is useless without it. */
function StartAgentHelp() {
  return (
    <section className="mt-10">
      <SectionLabel>Starting an agent</SectionLabel>
      <Card className="p-4">
        <ol className="text-body-sm text-ink-dim space-y-3 leading-relaxed">
          <li>
            <span className="text-ink">1.</span>{' '}Register a runner above and copy its token. It is
            shown once.
          </li>
          <li>
            <span className="text-ink">2.</span>{' '}On a host that can already reach the application
            under test, write{' '}
            <code className="border-line bg-surface rounded border px-1 py-0.5 font-mono text-micro">
              qaai-runner.json
            </code>{' '}
            naming the executor you already use. The agent runs that command and nothing else —
            QAAI sends test source, never an argv.
          </li>
          <li>
            <span className="text-ink">3.</span>{' '}Start it:
            <code className="border-line bg-surface mt-2 block overflow-x-auto rounded border px-3 py-2 font-mono text-micro">
              export QAAI_RUNNER_TOKEN=&apos;qaai_rt_…&apos;
              <br />
              qaai runner --api-url {API_URL}
            </code>
          </li>
          <li>
            <span className="text-ink">4.</span>{' '}Point an environment at the runner&apos;s pool.
            Until an environment names a pool, its runs go to QAAI&apos;s own workers and this queue
            stays empty.{' '}
            <Link href="/environments" className="text-accent hover:underline">
              Environments
            </Link>
          </li>
        </ol>
        <p className="text-ink-faint text-micro mt-4 leading-relaxed">
          Outbound HTTPS to {API_URL} is the only network access the agent needs. It refuses
          redirects while holding a token, and it will not follow a host named in any response.
        </p>
      </Card>
    </section>
  );
}
