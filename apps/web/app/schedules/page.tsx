'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { MonitorRow, ScheduleRow } from '../../components/schedules/AutomationRow';
import { MonitorDialog } from '../../components/schedules/MonitorDialog';
import { ScheduleDialog } from '../../components/schedules/ScheduleDialog';
import type {
  AutomationView,
  Monitor,
  MonitorDraft,
  Schedule,
  ScheduleDraft,
} from '../../components/schedules/types';
import { SetupHeader } from '../../components/setup/SetupHeader';
import { usePaletteCommands } from '../../components/shell/PaletteCommands';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ConfirmDialog } from '../../components/ui/Modal';
import { Page, SectionLabel, SkeletonRows } from '../../components/ui/layout';
import { useToast } from '../../components/ui/Toast';

/**
 * Schedules and monitors (§6) — the screen for a feature that already worked.
 *
 * The API could create a schedule, the worker's sweep fired them, and there was
 * no screen anywhere: no way to see one, pause one, retime one or delete one.
 * A customer who wanted a nightly run had to POST it by hand and then trust it.
 * So the bar for this page is not "lists rows" — it is that a person can look
 * at it and know, without decoding anything, what their automation does and
 * whether it is working.
 *
 * ── Why two lists and not one table ─────────────────────────────────────────
 *
 * A schedule and a monitor share a data shape and share nothing else. A
 * schedule answers "run this at 3am"; a monitor answers "keep checking this and
 * shout when it has been down long enough to matter". They have different
 * cadences (a cron in a named timezone against a bare interval), different
 * states (armed/paused against a failure streak measured off a threshold) and
 * different failure modes. Merging them into one table with half the columns
 * blank on every row is how the distinction would get lost.
 *
 * ── The refresh, and why it is not a poll ───────────────────────────────────
 *
 * Nothing here moves on its own inside a minute — the sweep's finest useful
 * grain is a minute and most rows are nightly — so this loads on arrival and
 * after every mutation, and does not poll. `now` is stamped once per load so
 * every relative age on the page is measured from the same instant; ages
 * computed from `Date.now()` inside each row drift against each other during a
 * render and produce lists where the same timestamp reads two ways.
 */
export default function SchedulesPage() {
  const router = useRouter();
  const toast = useToast();
  // Which app's automation this is is the shell's session-wide selection.
  const { projectId, loading: projectLoading } = useProject();

  const [view, setView] = useState<AutomationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [canEdit, setCanEdit] = useState(false);

  const [scheduleDialog, setScheduleDialog] = useState<{ open: boolean; editing: Schedule | null }>(
    { open: false, editing: null },
  );
  const [monitorDialog, setMonitorDialog] = useState<{ open: boolean; editing: Monitor | null }>({
    open: false,
    editing: null,
  });
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The id of the row with a request in flight, so only that row goes busy. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<
    { kind: 'schedule' | 'monitor'; id: string; name: string } | null
  >(null);

  /*
   * Switching projects mid-flight must not let the slower response win and
   * repaint the previous project's schedules over the new one's — the same
   * ticket guard the environments screen uses, and for the same reason.
   */
  const request = useRef(0);
  const load = useCallback(async (pid: string) => {
    const ticket = ++request.current;
    const next = await api<AutomationView>(`/automation/${pid}`);
    if (ticket !== request.current) return;
    setView(next);
    setNow(Date.now());
  }, []);

  const reload = useCallback(async () => {
    if (!projectId) return;
    await load(projectId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not reload the schedules');
    });
  }, [projectId, load]);

  useEffect(() => {
    // No project selected yet: drop the last one's rows and stay in the loading
    // shape. `noProject` below is what distinguishes "none" from "not fetched".
    if (!projectId) {
      request.current++;
      setView(null);
      return;
    }
    setView(null);
    setLoading(true);
    setError(null);
    void load(projectId)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the schedules');
      })
      .finally(() => setLoading(false));
  }, [projectId, load, router]);

  useEffect(() => {
    // A VIEWER may read this screen and may change nothing on it. The API is
    // the enforcement (requireRole('MEMBER')); this only stops offering buttons
    // that can exclusively 403.
    void api<{ activeOrgId: string; orgs: Array<{ id: string; role: string }> }>('/auth/me')
      .then((me) => {
        const role = me.orgs.find((org) => org.id === me.activeOrgId)?.role;
        setCanEdit(role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER');
      })
      .catch(() => setCanEdit(false));
  }, []);

  const suiteById = useMemo(
    () => new Map((view?.suites ?? []).map((suite) => [suite.id, suite])),
    [view],
  );
  const envById = useMemo(
    () => new Map((view?.environments ?? []).map((env) => [env.id, env])),
    [view],
  );

  const openNewSchedule = useCallback(() => {
    setDialogError(null);
    setScheduleDialog({ open: true, editing: null });
  }, []);
  const openNewMonitor = useCallback(() => {
    setDialogError(null);
    setMonitorDialog({ open: true, editing: null });
  }, []);

  /*
   * Two commands, offered only when they can actually be serviced: creating
   * either one needs a project, a suite to run and an environment to run it
   * against, and a palette entry that can only fail is worse than none.
   */
  const canCreate = Boolean(
    canEdit && projectId && (view?.suites.length ?? 0) > 0 && (view?.environments.length ?? 0) > 0,
  );
  usePaletteCommands(
    'schedules',
    () =>
      canCreate
        ? [
            {
              id: 'schedule:new',
              label: 'New schedule',
              detail: 'run a suite on a cron',
              group: 'Automation',
              run: openNewSchedule,
            },
            {
              id: 'monitor:new',
              label: 'New monitor',
              detail: 'check a suite on an interval',
              group: 'Automation',
              run: openNewMonitor,
            },
          ]
        : [],
    [canCreate, openNewSchedule, openNewMonitor],
  );

  async function mutate(id: string, work: () => Promise<void>, failure: string) {
    setBusyId(id);
    setError(null);
    try {
      await work();
      await reload();
    } catch (err) {
      const message = err instanceof Error ? err.message : failure;
      setError(message);
      toast.error(message);
    } finally {
      setBusyId(null);
    }
  }

  function toggleSchedule(schedule: Schedule) {
    void mutate(
      schedule.id,
      async () => {
        await api(`/automation/${projectId}/schedules/${schedule.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !schedule.enabled }),
        });
        toast.success(
          schedule.enabled
            ? `${schedule.name} is paused.`
            : // Resuming re-arms from now, so it does not immediately fire the
              // run it missed while it was off. Worth saying, because the
              // opposite is what people brace for.
              `${schedule.name} is running again, from its next scheduled time.`,
        );
      },
      'Could not change the schedule',
    );
  }

  function toggleMonitor(monitor: Monitor) {
    void mutate(
      monitor.id,
      async () => {
        await api(`/automation/${projectId}/monitors/${monitor.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !monitor.enabled }),
        });
        toast.success(
          monitor.enabled
            ? `${monitor.name} is paused.`
            : `${monitor.name} is checking again, with its failure streak reset.`,
        );
      },
      'Could not change the monitor',
    );
  }

  async function submitSchedule(draft: ScheduleDraft) {
    if (!projectId) return;
    setSaving(true);
    setDialogError(null);
    const editing = scheduleDialog.editing;
    try {
      if (editing) {
        await api(`/automation/${projectId}/schedules/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(draft),
        });
      } else {
        await api(`/projects/${projectId}/schedules`, {
          method: 'POST',
          body: JSON.stringify(draft),
        });
      }
      setScheduleDialog({ open: false, editing: null });
      toast.success(editing ? `${draft.name} saved.` : `${draft.name} created.`);
      await reload();
    } catch (err) {
      // Into the dialog, not a toast: the field that needs fixing is on screen
      // and the message names it ("… is not a cron expression").
      setDialogError(err instanceof Error ? err.message : 'Could not save the schedule');
    } finally {
      setSaving(false);
    }
  }

  async function submitMonitor(draft: MonitorDraft) {
    if (!projectId) return;
    setSaving(true);
    setDialogError(null);
    const editing = monitorDialog.editing;
    try {
      if (editing) {
        await api(`/automation/${projectId}/monitors/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(draft),
        });
      } else {
        await api(`/projects/${projectId}/monitors`, {
          method: 'POST',
          body: JSON.stringify(draft),
        });
      }
      setMonitorDialog({ open: false, editing: null });
      toast.success(editing ? `${draft.name} saved.` : `${draft.name} created.`);
      await reload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : 'Could not save the monitor');
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    const target = pendingDelete;
    if (!target || !projectId) return;
    void mutate(
      target.id,
      async () => {
        await api(`/projects/${projectId}/${target.kind}s/${target.id}`, { method: 'DELETE' });
        setPendingDelete(null);
        toast.success(`${target.name} deleted.`);
      },
      `Could not delete the ${target.kind}`,
    );
  }

  const noProject = !projectLoading && !projectId;
  const schedules = view?.schedules ?? [];
  const monitors = view?.monitors ?? [];
  const suites = view?.suites ?? [];
  const environments = view?.environments ?? [];

  /*
   * Why a schedule cannot be created is a different sentence from "you have
   * none" and belongs in the empty state, not behind a button that does
   * nothing: a schedule needs a suite to run and an environment to run it
   * against, and a project can legitimately have neither yet.
   */
  const blocker =
    suites.length === 0
      ? {
          body: 'A schedule runs a saved suite, and this app has none yet. Group some tests into a suite first, then come back and give it a clock.',
          action: { label: 'Open the editor', href: '/editor' },
        }
      : environments.length === 0
        ? {
            body: 'A schedule needs somewhere to point. Add an environment — a base URL and its credentials — and this app can start running on a clock.',
            action: { label: 'Add an environment', href: '/environments' },
          }
        : null;

  return (
    <Page width="setup">
      <SetupHeader eyebrowTail="Schedules" />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-row-sub mt-6 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
        >
          {error}
        </p>
      )}

      {noProject ? (
        <div className="mt-7">
          <EmptyState
            title="No app to automate yet"
            body="Schedules and monitors hang off an app: a nightly run of its suite, or a check every fifteen minutes against its production URL. Add an app and they become available."
            action={{ label: 'Add app', href: '/onboarding' }}
          />
        </div>
      ) : (
        <div className="mt-7 space-y-11">
          {/* ── Schedules ───────────────────────────────────────────────── */}
          <section>
            <div className="mb-2.5 flex items-baseline justify-between gap-4">
              <SectionLabel className="mb-0">Schedules</SectionLabel>
              {canEdit && schedules.length > 0 && (
                <Button size="sm" onClick={openNewSchedule} disabled={blocker !== null}>
                  + New schedule
                </Button>
              )}
            </div>

            {loading ? (
              <SkeletonRows rows={2} />
            ) : schedules.length === 0 ? (
              <EmptyState
                title="Nothing runs on its own yet"
                body={
                  blocker?.body ??
                  'A schedule runs one suite against one environment on a repeating clock — a nightly regression at 3am, a smoke test every Monday morning. It is how a suite keeps earning its keep without anybody remembering to press a button.'
                }
                action={
                  blocker
                    ? blocker.action
                    : canEdit
                      ? { label: 'New schedule', onClick: openNewSchedule }
                      : undefined
                }
              />
            ) : (
              <ul>
                {schedules.map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    suite={suiteById.get(schedule.suiteId)}
                    environment={envById.get(schedule.environmentId)}
                    now={now}
                    busy={busyId === schedule.id}
                    canEdit={canEdit}
                    onToggle={() => toggleSchedule(schedule)}
                    onEdit={() => {
                      setDialogError(null);
                      setScheduleDialog({ open: true, editing: schedule });
                    }}
                    onDelete={() =>
                      setPendingDelete({
                        kind: 'schedule',
                        id: schedule.id,
                        name: schedule.name,
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          {/* ── Monitors ────────────────────────────────────────────────── */}
          <section>
            <div className="mb-2.5 flex items-baseline justify-between gap-4">
              <SectionLabel className="mb-0">Monitors</SectionLabel>
              {canEdit && monitors.length > 0 && (
                <Button size="sm" onClick={openNewMonitor} disabled={blocker !== null}>
                  + New monitor
                </Button>
              )}
            </div>

            {loading ? (
              <SkeletonRows rows={1} />
            ) : monitors.length === 0 ? (
              <EmptyState
                title="Nothing is watching production"
                body={
                  blocker?.body ??
                  'A monitor re-runs a suite on a fixed interval and pages once it has failed a set number of times in a row — three checks, not one, so a single flaky moment does not wake anybody. It is the difference between finding out at 3am and finding out from a customer.'
                }
                action={
                  blocker
                    ? blocker.action
                    : canEdit
                      ? { label: 'New monitor', onClick: openNewMonitor }
                      : undefined
                }
              />
            ) : (
              <ul>
                {monitors.map((monitor) => (
                  <MonitorRow
                    key={monitor.id}
                    monitor={monitor}
                    suite={suiteById.get(monitor.suiteId)}
                    environment={envById.get(monitor.environmentId)}
                    now={now}
                    busy={busyId === monitor.id}
                    canEdit={canEdit}
                    onToggle={() => toggleMonitor(monitor)}
                    onEdit={() => {
                      setDialogError(null);
                      setMonitorDialog({ open: true, editing: monitor });
                    }}
                    onDelete={() =>
                      setPendingDelete({ kind: 'monitor', id: monitor.id, name: monitor.name })
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <ScheduleDialog
        open={scheduleDialog.open}
        onClose={() => setScheduleDialog({ open: false, editing: null })}
        onSubmit={(draft) => void submitSchedule(draft)}
        existing={scheduleDialog.editing}
        suites={suites}
        environments={environments}
        busy={saving}
        error={dialogError}
      />

      <MonitorDialog
        open={monitorDialog.open}
        onClose={() => setMonitorDialog({ open: false, editing: null })}
        onSubmit={(draft) => void submitMonitor(draft)}
        existing={monitorDialog.editing}
        suites={suites}
        environments={environments}
        busy={saving}
        error={dialogError}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={pendingDelete?.kind === 'monitor' ? 'Delete monitor' : 'Delete schedule'}
        body={
          pendingDelete
            ? pendingDelete.kind === 'monitor'
              ? `Delete “${pendingDelete.name}”? Nothing will check this suite again, and nobody will be paged when it starts failing. Runs it has already produced are kept.`
              : `Delete “${pendingDelete.name}”? This suite stops running on its own. Runs it has already produced are kept.`
            : ''
        }
        confirmLabel={pendingDelete?.kind === 'monitor' ? 'Delete monitor' : 'Delete schedule'}
        busy={busyId === pendingDelete?.id}
      />
    </Page>
  );
}
