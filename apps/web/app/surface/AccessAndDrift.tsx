'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type {
  AccessCell,
  AccessReport,
  AuthProfileKindReport,
  ReEnumerationReport,
  RoleAttempt,
  RouteAccessOutcome,
  SurfaceDriftFeed,
  SurfaceDriftRecordView,
} from '../../lib/api';
import { Badge, SectionLabel, SkeletonRows } from '../../components/ui/layout';

/**
 * The three facts a denominator is worthless without, on the screen that owns
 * the denominator.
 *
 * ── Why these three sit together ────────────────────────────────────────────
 *
 * "Your app has 412 routes, 25 are covered" is only worth saying if it is true,
 * and three things can make it untrue without anything looking wrong:
 *
 *   · the authorization axis has no denominator at all, because one identity
 *     was used for the whole crawl — so "a member gets 403 on /admin" was not
 *     sayable, and a cell nobody checked and a cell that returned 403 were
 *     indistinguishable;
 *   · nothing compared two crawls, so new surface with no tests produced no
 *     event, and a quiet screen read as "nothing changed";
 *   · the environment may be behind a bot defence, in which case the
 *     authenticated half of the number is zero for a reason that has nothing to
 *     do with testing.
 *
 * ── The one rule this file is written to ────────────────────────────────────
 *
 * A null is never drawn as a zero and an empty table is never drawn as a clean
 * result. Every `null` from the API arrives with a sentence beside it, and the
 * sentence is rendered. The one case that matters most is the matrix below: a
 * NOT_PROBED cell is tinted and labelled, because a 403 cell and an unchecked
 * cell reading the same way is the UI half of exactly the lie the measurement
 * underneath was rebuilt to stop telling.
 *
 * No new visual language: `Badge`, `SectionLabel` and the hairline-row idiom
 * from components/surface/SurfaceList.tsx, unchanged.
 */

export interface AccessAndDriftData {
  access: AccessReport | null;
  drift: SurfaceDriftFeed | null;
  reEnumeration: ReEnumerationReport | null;
  kinds: AuthProfileKindReport | null;
  loading: boolean;
  error: string | null;
}

/**
 * `projectSettling` is the shell still deciding which project is selected; it
 * has to hold the loading state, because resolving it to "no environment" for
 * one frame renders an empty state over a project that is about to arrive.
 * Same contract as `useDarkSurface`.
 */
export function useAccessAndDrift(
  projectId: string | null,
  environmentId: string | null,
  projectSettling: boolean,
): AccessAndDriftData {
  const [data, setData] = useState<Omit<AccessAndDriftData, 'loading' | 'error'>>({
    access: null,
    drift: null,
    reEnumeration: null,
    kinds: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (project: string, environment: string) => {
    const base = `/projects/${project}/environments/${environment}`;
    /*
     * Four independent reads, and a failure in one must not take the others
     * down: "we could not read the drift feed" and "there is no drift" are the
     * two sentences this screen exists to keep apart, so a rejected promise
     * becomes a null the renderer reports rather than a blank panel.
     */
    const [access, drift, reEnumeration, kinds] = await Promise.all([
      api<AccessReport>(`${base}/access`).catch(() => null),
      api<SurfaceDriftFeed>(`${base}/surface-drift`).catch(() => null),
      api<ReEnumerationReport>(`${base}/re-enumeration`).catch(() => null),
      api<AuthProfileKindReport>(`/auth-profile-kinds?environmentId=${environment}`).catch(
        () => null,
      ),
    ]);
    return { access, drift, reEnumeration, kinds };
  }, []);

  useEffect(() => {
    if (projectSettling) return;
    if (!projectId || !environmentId) {
      setData({ access: null, drift: null, reEnumeration: null, kinds: null });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await fetchAll(projectId, environmentId);
        if (!cancelled) setData(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read this environment');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, environmentId, projectSettling, fetchAll]);

  return { ...data, loading: loading || projectSettling, error };
}

// ─── The matrix cell, which is the whole point of the screen ─────────────────

/**
 * How each outcome is drawn, and why NOT_PROBED is not neutral.
 *
 * Tones describe MEASUREDNESS, not desirability. A 403 for a member on /admin
 * is the DESIRED result, so drawing it red would be an accusation; it is a
 * measurement and reads as one. The two chips that are not measurements are the
 * two that are tinted:
 *
 *   NOT_PROBED  nobody asked. Tinted amber and labelled, because this is the
 *               cell that must never be skimmed past as if it were a result.
 *   ERRORED     we asked and learned nothing about authorization. A 429 or a
 *               500 is not a security finding.
 */
const OUTCOME_TONE: Record<RouteAccessOutcome, 'neutral' | 'accent' | 'pass' | 'fail' | 'flake'> = {
  ALLOWED: 'pass',
  FORBIDDEN: 'accent',
  REDIRECTED_TO_LOGIN: 'accent',
  REDIRECTED_ELSEWHERE: 'neutral',
  NOT_FOUND: 'neutral',
  ERRORED: 'fail',
  NOT_PROBED: 'flake',
};

const OUTCOME_LABEL: Record<RouteAccessOutcome, string> = {
  ALLOWED: 'ALLOWED',
  FORBIDDEN: 'FORBIDDEN',
  REDIRECTED_TO_LOGIN: 'TO LOGIN',
  REDIRECTED_ELSEWHERE: 'REDIRECTED',
  NOT_FOUND: 'NOT FOUND',
  ERRORED: 'ERRORED',
  /* Not "—", not blank. The absence of a measurement is a value. */
  NOT_PROBED: 'NOT PROBED',
};

/** Is this cell a measurement of authorization at all? Mirrors `isRouteAccessMeasured`. */
function cellIsMeasured(cell: AccessCell): boolean {
  return cell.basis === 'OBSERVED' && cell.outcome !== 'NOT_PROBED' && cell.outcome !== 'ERRORED';
}

function CellChip({ cell }: { cell: AccessCell }) {
  const measured = cellIsMeasured(cell);
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Badge tone={OUTCOME_TONE[cell.outcome]} tint={!measured}>
        {OUTCOME_LABEL[cell.outcome]}
      </Badge>
      {/* The status, when there is one. NULL is left absent rather than shown
          as 0 — a 0 status is not a thing an HTTP response can have. */}
      {cell.status !== null && (
        <span className="text-ink-faint text-micro font-mono tabular-nums">{cell.status}</span>
      )}
      {cell.basis === 'DECLARED' && <span className="text-ink-faint text-micro">declared</span>}
    </span>
  );
}

function AccessMatrix({ report }: { report: AccessReport }) {
  if (report.counts.total === 0) {
    return (
      <p className="text-ink-dim text-row-sub leading-relaxed">
        {report.why ??
          'Nobody has probed the authorization axis on this environment. This is NOT a report that the application has no role restrictions.'}
      </p>
    );
  }

  /* One row per route, one chip per role, so a reader scans across an identity. */
  const roles = [...new Set(report.cells.map((cell) => cell.role))].sort();
  const byRoute = new Map<string, AccessCell[]>();
  for (const cell of report.cells) {
    const existing = byRoute.get(cell.routeTemplate);
    if (existing) existing.push(cell);
    else byRoute.set(cell.routeTemplate, [cell]);
  }

  return (
    <div>
      <p className="text-ink-dim text-row-sub mb-2.5 leading-relaxed">
        {report.counts.measured} of {report.counts.shown} cells on this page are a measurement;{' '}
        {report.counts.notMeasured} were never probed or taught us nothing. A cell nobody asked
        about is not a cell that was allowed.
      </p>
      {report.atLeastMoreCells !== null && (
        <p className="text-ink-faint text-micro mb-2.5">
          Capped by {report.cappedBy}: at least {report.atLeastMoreCells} more cells exist and are
          not shown here.
        </p>
      )}
      {[...byRoute.entries()].map(([route, cells]) => (
        <div key={route} className="border-line border-b py-3">
          <span className="text-row text-ink font-mono break-all">{route}</span>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
            {roles.map((role) => {
              const cell = cells.find((candidate) => candidate.role === role);
              return (
                <span key={role} className="inline-flex items-baseline gap-1.5">
                  <span className="text-ink-faint text-micro font-mono">{role}</span>
                  {cell ? (
                    <CellChip cell={cell} />
                  ) : (
                    /* No row at all is the same fact as NOT_PROBED and is drawn
                       the same way, rather than as a gap in the grid. */
                    <Badge tone="flake" tint>
                      NOT PROBED
                    </Badge>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Roles, and the difference between a failed login and an empty wall ──────

const FAULT_LABEL: Record<RoleAttempt['fault'], string> = {
  OURS: 'our gap',
  THEIRS: 'your application',
  NOBODY: 'nobody',
};

function RoleRow({ attempt }: { attempt: RoleAttempt }) {
  /*
   * `hadNoExtraSurface` is NULL whenever the question cannot be answered — a
   * login that failed, a crawl that never ran, or a capped crawl that happened
   * to find nothing new. The outcome is rendered instead. "admin sees nothing
   * extra" is the dangerous sentence, and it is unreachable from here.
   */
  const verdict =
    attempt.hadNoExtraSurface === null
      ? null
      : attempt.hadNoExtraSurface
        ? 'reached no surface the other identities did not'
        : `reached ${attempt.routesNewToThisRole} route(s) no other identity did`;

  return (
    <div className="border-line border-b py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-row text-ink font-mono break-all">{attempt.role}</span>
        <Badge
          tone={attempt.outcome === 'CRAWLED' ? 'pass' : attempt.outcome === 'CRAWLED_PARTIAL' ? 'flake' : 'fail'}
          tint={attempt.outcome !== 'CRAWLED'}
        >
          {attempt.outcome.replace(/_/g, ' ')}
        </Badge>
        {attempt.fault !== 'NOBODY' && <Badge>fault: {FAULT_LABEL[attempt.fault]}</Badge>}
        <span className="text-ink-faint text-micro ml-auto shrink-0 tabular-nums">
          {/* NULL is drawn as "not measured", never as 0. */}
          {attempt.routesReached === null
            ? 'routes reached: not measured'
            : `${attempt.routesReached} routes reached`}
        </span>
      </div>
      {verdict ? (
        <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">This identity {verdict}.</p>
      ) : (
        <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
          Whether this identity has surface of its own is UNKNOWN — the crawl for it did not
          complete, so an empty result here is not a result.
        </p>
      )}
      {attempt.detail && <p className="text-ink-faint text-micro mt-1">{attempt.detail}</p>}
      {attempt.cappedBy && (
        <p className="text-ink-faint text-micro mt-1">
          Capped by {attempt.cappedBy}
          {attempt.atLeastMoreRoutes !== null
            ? `: at least ${attempt.atLeastMoreRoutes} more routes existed for this identity`
            : ' — how much more it would have reached is unknown'}
          .
        </p>
      )}
      {attempt.remedy && <p className="text-accent text-micro mt-1">{attempt.remedy}</p>}
    </div>
  );
}

// ─── Drift ───────────────────────────────────────────────────────────────────

function DriftRow({ record }: { record: SurfaceDriftRecordView }) {
  const comparable = record.comparability === 'COMPARABLE';
  return (
    <div className="border-line border-b py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/*
         * `newSurfaceWithoutTests` is already read through the shared predicate
         * by the API, so null here means the comparison did not happen or the
         * row is a writer bug. Either way it is the WORD, never a 0.
         */}
        <span className="text-row text-ink font-mono">
          {record.newSurfaceWithoutTests === null
            ? 'not measured'
            : `${record.newSurfaceWithoutTests} new surface with no test`}
        </span>
        <Badge tone={comparable ? 'neutral' : 'flake'} tint={!comparable}>
          {record.comparability.replace(/_/g, ' ')}
        </Badge>
        {record.trigger && <Badge>{record.trigger.kind.toLowerCase()}</Badge>}
        <span className="text-ink-faint text-micro ml-auto shrink-0">
          {record.comparedAt
            ? new Date(record.comparedAt).toLocaleString()
            : 'no comparison was made'}
        </span>
      </div>
      {record.counts ? (
        <p className="text-ink-dim text-row-sub mt-1 tabular-nums">
          {record.counts.routesAdded ?? '—'} routes added · {record.counts.routesChanged ?? '—'}{' '}
          changed ·{' '}
          {record.counts.routesRemoved === null
            ? 'removals refused'
            : `${record.counts.routesRemoved} removed`}{' '}
          · {record.counts.controlsAdded ?? '—'} controls added
        </p>
      ) : (
        <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
          {record.why ?? 'This was not a comparison, so there are no counts to report.'}
        </p>
      )}
      {record.removalsRefusedBecause && (
        <p className="text-ink-faint text-micro mt-1">
          Removals were REFUSED, not measured as none: {record.removalsRefusedBecause}
        </p>
      )}
      {record.testednessUnmeasuredBecause && (
        <p className="text-ink-faint text-micro mt-1">{record.testednessUnmeasuredBecause}</p>
      )}
    </div>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────

export function AccessAndDrift({ data }: { data: AccessAndDriftData }) {
  const { access, drift, reEnumeration, kinds, loading, error } = data;

  if (loading) return <SkeletonRows rows={4} />;
  if (error) return <p className="text-fail text-row-sub">{error}</p>;
  if (!access && !drift && !reEnumeration && !kinds) {
    return (
      <p className="text-ink-dim text-row-sub leading-relaxed">
        Pick an environment to see its authorization coverage, its reachability and what the last
        two crawls of it differed by.
      </p>
    );
  }

  /* A kind the cockpit offers that this install cannot actually perform. */
  const unperformable = (kinds?.kinds ?? []).filter((entry) => entry.unavailable !== null);
  const refused = (kinds?.kinds ?? []).filter((entry) => entry.refusedHere !== null);

  return (
    <div className="mt-[26px] flex flex-col gap-[26px]">
      <section>
        <SectionLabel>Reachability</SectionLabel>
        {/*
         * NOT_PROBED is its own sentence. The absence of an access row means
         * nobody has looked, and rendering that as "reachable" is how an access
         * problem comes to look like a testing failure.
         */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Badge
            tone={access?.reachability === 'UNREACHABLE_BEHIND_BOT_PROTECTION' ? 'fail' : 'flake'}
            tint
          >
            {(access?.reachability ?? 'NOT_PROBED').replace(/_/g, ' ')}
          </Badge>
          {access?.access?.provider && access.access.provider !== 'NONE' && (
            <Badge>{access.access.provider}</Badge>
          )}
          {access?.access?.bypassMode && (
            <Badge>{access.access.bypassMode.replace(/_/g, ' ').toLowerCase()}</Badge>
          )}
        </div>
        {access?.reachabilityWhy && (
          <p className="text-ink-dim text-row-sub mt-1.5 leading-relaxed">
            {access.reachabilityWhy}
          </p>
        )}
        {access?.access?.observedSignal && (
          <p className="text-ink-faint text-micro mt-1 font-mono break-all">
            observed: {access.access.observedSignal}
          </p>
        )}
        {access?.access?.extraHeaderNames.length ? (
          <p className="text-ink-faint text-micro mt-1">
            {/* NAMES only. The API never returns a header value. */}
            Headers sent with every request: {access.access.extraHeaderNames.join(', ')} (values
            withheld).
          </p>
        ) : null}
      </section>

      {(unperformable.length > 0 || refused.length > 0) && (
        <section>
          <SectionLabel>Sign-in methods this install cannot perform</SectionLabel>
          <p className="text-ink-dim text-row-sub mb-2.5 leading-relaxed">
            A method offered on the auth-profile form that no adapter here can drive produces an
            authenticated surface of zero, with no explanation. These are those methods, named in
            advance. {kinds?.note}
          </p>
          {unperformable.map((entry) => (
            <div key={entry.kind} className="border-line border-b py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-row text-ink font-mono">{entry.kind}</span>
                <Badge tone="flake" tint>
                  UNAVAILABLE
                </Badge>
                <span className="text-ink-faint text-micro">
                  missing: {entry.unavailable?.missing.join(', ')}
                </span>
                {entry.storedCount > 0 && (
                  <Badge tone="fail" tint>
                    {entry.storedCount} profile(s) stored
                  </Badge>
                )}
              </div>
              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
                {entry.unavailable?.remedy}
              </p>
            </div>
          ))}
          {refused.map((entry) => (
            <div key={entry.kind} className="border-line border-b py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-row text-ink font-mono">{entry.kind}</span>
                <Badge tone="fail" tint>
                  REFUSED HERE
                </Badge>
              </div>
              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">{entry.refusedHere}</p>
            </div>
          ))}
        </section>
      )}

      <section>
        <SectionLabel>Who could be crawled as</SectionLabel>
        {access && access.roles.length > 0 ? (
          access.roles.map((attempt) => <RoleRow key={attempt.role} attempt={attempt} />)
        ) : (
          <p className="text-ink-dim text-row-sub leading-relaxed">
            No identity has been crawled as on this environment, so there is no authorization
            denominator at all. This is NOT a report that the application has one role.
          </p>
        )}
      </section>

      <section>
        <SectionLabel>Route by identity</SectionLabel>
        {access ? (
          <AccessMatrix report={access} />
        ) : (
          <p className="text-ink-dim text-row-sub">The authorization matrix could not be read.</p>
        )}
      </section>

      <section>
        <SectionLabel>Re-enumeration</SectionLabel>
        {reEnumeration?.why && (
          <p className="text-ink-dim text-row-sub mb-2.5 leading-relaxed">{reEnumeration.why}</p>
        )}
        {(reEnumeration?.triggers ?? []).map((entry) => (
          <div key={entry.id} className="border-line border-b py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-row text-ink font-mono break-all">{entry.name}</span>
              <Badge>{entry.kind.toLowerCase()}</Badge>
              {/*
               * `hasRun` comes from the shared predicate, not from lastRunAt. A
               * NEVER_RUN trigger renders as never-run and never as "no drift".
               */}
              <Badge tone={entry.hasRun ? 'neutral' : 'flake'} tint={!entry.hasRun}>
                {entry.lastRunState.replace(/_/g, ' ')}
              </Badge>
              {!entry.enabled && <Badge tone="flake">disabled</Badge>}
              {entry.consecutiveFailures > 0 && (
                <Badge tone="fail" tint>
                  {entry.consecutiveFailures} failures in a row
                </Badge>
              )}
              <span className="text-ink-faint text-micro ml-auto shrink-0">
                {entry.lastRunAt ? new Date(entry.lastRunAt).toLocaleString() : 'never fired'}
              </span>
            </div>
            {entry.cron && (
              <p className="text-ink-faint text-micro mt-1 font-mono">
                {entry.cron} ({entry.timezone ?? 'UTC'})
              </p>
            )}
            {entry.staleness && (
              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">{entry.staleness}</p>
            )}
            {entry.lastFailureMessage && (
              <p className="text-ink-faint text-micro mt-1">{entry.lastFailureMessage}</p>
            )}
          </div>
        ))}
      </section>

      <section>
        <SectionLabel>What changed since the last crawl</SectionLabel>
        {drift?.why && (
          <p className="text-ink-dim text-row-sub mb-2.5 leading-relaxed">{drift.why}</p>
        )}
        {(drift?.records ?? []).map((record) => (
          <DriftRow key={record.id} record={record} />
        ))}
        {!drift && (
          <p className="text-ink-dim text-row-sub leading-relaxed">
            The drift feed could not be read. That is not a report that nothing changed.
          </p>
        )}
      </section>
    </div>
  );
}
