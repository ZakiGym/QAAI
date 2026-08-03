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
import { SetupHeader } from '../../../components/setup/SetupHeader';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Field } from '../../../components/ui/Field';
import { ConfirmDialog, Modal } from '../../../components/ui/Modal';
import { useToast } from '../../../components/ui/Toast';
import { Page, SectionLabel, SkeletonRows } from '../../../components/ui/layout';
import { cn } from '../../../lib/cn';

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
  const [showHelp, setShowHelp] = useState(false);

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
    if (!trimmed || busy) return;
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
    <Page width="setup">
      <SetupHeader />

      <div className="mt-7">
        {error && (
          <p
            role="alert"
            className="border-fail/40 text-fail text-row-sub mb-5 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
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

        {/* ── The fleet ────────────────────────────────────────────────────── */}
        <section className={minted ? 'mt-5' : ''}>
          <SectionLabel>Fleet{runners && runners.length > 0 ? ` · ${runners.length}` : ''}</SectionLabel>

          {loading ? (
            <SkeletonRows rows={3} />
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
            <p className="text-ink-faint text-micro mt-2.5 font-mono">
              registering, rotating and revoking are limited to organization admins
            </p>
          )}
        </section>

        {/* ── The queue ────────────────────────────────────────────────────── */}
        {!loading && <QueueSection queue={queue} now={now} />}

        {/* ── Getting one running ──────────────────────────────────────────── */}
        <p className="mt-3.5 flex flex-wrap items-baseline gap-x-2">
          {canManage ? (
            <button
              type="button"
              onClick={() => setRegistering(true)}
              className="text-accent text-[12px] hover:underline"
            >
              + register a runner
            </button>
          ) : (
            <span className="text-ink-faint text-[12px]">registering needs an admin</span>
          )}
          <span className="text-ink-faint text-micro font-mono">
            · runs inside your network · outbound-only
          </span>
        </p>

        <p className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <button
            type="button"
            onClick={() => setShowHelp((s) => !s)}
            aria-expanded={showHelp}
            className="text-ink-faint hover:text-ink text-[12px] transition-colors"
          >
            {showHelp ? '– hide how to start an agent' : 'how to start an agent →'}
          </button>
          {/* The GitHub App is a sibling of this screen, not a tab of it: same
              section, same question (what may QAAI touch), different subject. */}
          <Link href="/settings/github" className="text-ink-faint hover:text-ink text-[12px] transition-colors">
            GitHub App →
          </Link>
        </p>

        {(showHelp || (!loading && runners.length === 0)) && <StartAgentHelp />}
      </div>

      {/* ── Register ──────────────────────────────────────────────────────── */}
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

      {/* ── Rotate / revoke ───────────────────────────────────────────────── */}
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
 *
 * The whole token is on screen, not an eliding preview: the clipboard write can
 * fail silently (permissions, a headless browser, an unfocused document) and
 * when it does, retyping it is the only way left.
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
    <div
      role="status"
      className="rounded-lg border border-[color-mix(in_srgb,var(--color-flake)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-flake)_7%,transparent)] px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-[12.5px]">
          <span className="font-mono text-[11.5px] break-all">{token}</span>
          <span className="text-ink-dim">
            {' '}
            — {rotated ? `the new token for ${name}` : `${name} is registered`}; shown once, the
            server keeps only its hash. Copy it into the runner&apos;s env now.
          </span>
        </p>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(token);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss the token"
          className="text-ink-faint hover:text-ink p-0.5 text-[13px] transition-colors"
        >
          ✕
        </button>
      </div>
      <p className="text-ink-faint text-micro mt-2 font-mono">
        export QAAI_RUNNER_TOKEN=&apos;…&apos; · never on the command line — argv is readable by
        every other process on that box; --token-file exists for that reason
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

/** Row tint: held work is the only thing here anyone needs to act on. */
const STATUS_TEXT: Record<string, string> = {
  QUEUED: 'text-flake',
  CLAIMED: 'text-ink-dim',
  RUNNING: 'text-ink-dim',
  COMPLETED: 'text-pass',
  FAILED: 'text-fail',
  ABANDONED: 'text-fail',
  CANCELLED: 'text-ink-faint',
  SKIPPED: 'text-flake',
};

function QueueSection({ queue, now }: { queue: Queue; now: number }) {
  const rows = [...queue.attention, ...queue.waiting, ...queue.inFlight];

  return (
    <section className="mt-6">
      <SectionLabel>Queue</SectionLabel>
      {rows.length === 0 ? (
        <p className="text-ink-faint text-row-sub border-line border-b py-2.5">
          Nothing is queued for an on-prem pool.
          {queue.completed > 0 && ` The last ${queue.completed} finished without incident.`}{' '}
          Work only arrives here when an environment names a runner pool — otherwise runs go to
          QAAI&apos;s own workers.
        </p>
      ) : (
        <>
          {rows.slice(0, 25).map((job) => (
            <QueueRow key={job.id} job={job} now={now} />
          ))}
          {queue.completed > 0 && (
            <p className="text-ink-faint text-micro mt-2 font-mono tabular-nums">
              {queue.completed} completed job{queue.completed === 1 ? '' : 's'} in the last 200
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One held job, carrying its reason.
 *
 * The reason is the row. "Waiting 4m" is a fact anyone can read off a clock;
 * "no live runner in pool 'windows'" is the thing that tells them what to fix,
 * and it is what the sweep writes into `errorMessage`.
 */
function QueueRow({ job, now }: { job: RunnerJob; now: number }) {
  const waiting = job.status === 'QUEUED';
  const reason =
    job.errorMessage ??
    (waiting
      ? `waiting for a runner${job.pool ? ` in pool ‘${job.pool}’` : ''}`
      : `${job.status.toLowerCase()}${job.pool ? ` · pool ${job.pool}` : ''}`);

  return (
    <div className="border-line flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2.5">
      <p className={cn('min-w-0 flex-1 text-[13px]', STATUS_TEXT[job.status] ?? 'text-ink-dim')}>
        {reason}
        <span className="text-ink-faint">
          {' · '}
          <Link href={`/runs/${job.runId}`} className="font-mono hover:underline">
            {job.runId.slice(-8)}
          </Link>
          {job.shardIndex === null ? ' · whole run' : ` · shard ${job.shardIndex}`}
          {job.attempt > 1 && ` · attempt ${job.attempt} of ${job.maxAttempts}`}
          {' · '}
          {waiting
            ? `waiting ${elapsed(job.queuedAt, now)}`
            : job.finishedAt
              ? `${elapsed(job.finishedAt, now)} ago`
              : job.claimedAt
                ? `picked up ${elapsed(job.claimedAt, now)} ago`
                : `queued ${elapsed(job.queuedAt, now)} ago`}
        </span>
      </p>
    </div>
  );
}

/** How to actually start one — the screen is useless without it. */
function StartAgentHelp() {
  return (
    <section className="mt-5">
      <SectionLabel>Starting an agent</SectionLabel>
      <ol className="text-row-sub text-ink-dim space-y-3 leading-relaxed">
        <li>
          <span className="text-ink font-mono">1</span> Register a runner above and copy its token.
          It is shown once.
        </li>
        <li>
          <span className="text-ink font-mono">2</span> On a host that can already reach the
          application under test, write{' '}
          <code className="border-line bg-surface-1 text-micro rounded-sm border px-1 py-0.5 font-mono">
            qaai-runner.json
          </code>{' '}
          naming the executor you already use. The agent runs that command and nothing else — QAAI
          sends test source, never an argv.
        </li>
        <li>
          <span className="text-ink font-mono">3</span> Start it:
          <code className="border-line bg-surface-1 text-micro mt-2 block overflow-x-auto rounded-md border px-3 py-2 font-mono">
            export QAAI_RUNNER_TOKEN=&apos;qaai_rt_…&apos;
            <br />
            qaai runner --api-url {API_URL}
          </code>
        </li>
        <li>
          <span className="text-ink font-mono">4</span>{' '}
          Point an environment at the runner&apos;s pool. Until an environment names a pool, its
          runs go to QAAI&apos;s own workers and this queue stays empty.{' '}
          <Link href="/environments" className="text-accent hover:underline">
            Environments
          </Link>
        </li>
      </ol>
      <p className="text-ink-faint text-micro mt-3.5 font-mono">
        outbound HTTPS to {API_URL} is the only network access the agent needs · it refuses
        redirects while holding a token
      </p>
    </section>
  );
}
