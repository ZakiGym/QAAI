'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type TriageAccuracy, type TriageCause, type TriageCauseList } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';
import { SectionLabel } from '../ui/layout';
import { accuracyHeadline, capNote, ratePercentLabel } from './health';

/**
 * Two readers for two endpoints that shipped with none: the accuracy scorecard
 * (`GET /triage/accuracy`) and the mute roster (`GET /triage/signatures?muted=
 * true`), with the unmute door beside it.
 *
 * Both are about the queue rather than about one verdict, so they sit above it,
 * collapsed. Deliberately plain — no new visual language, the section label and
 * the button this app already has.
 *
 * ── Why the roster is not optional ──────────────────────────────────────────
 *
 * A mute stops a cause minting verdicts, which means it stops a failure
 * reaching this screen at all. The design says the suppression stays visible
 * and keeps being counted; with no reader, "visible" meant a column in the
 * database. A mute nobody can list is inherited in six weeks by somebody who
 * cannot tell whether it still applies — and `suppressed` is the number that
 * says what the silence has cost so far.
 */

export function TriageHealth({ projectId }: { projectId: string }) {
  const [accuracy, setAccuracy] = useState<TriageAccuracy | null>(null);
  const [muted, setMuted] = useState<TriageCauseList | null>(null);
  const [open, setOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = `?projectId=${encodeURIComponent(projectId)}`;
    /*
     * Both reads fail soft and independently. These are enrichments above a
     * working queue: a project with no verdicts yet, or an accuracy read that
     * 500s, must not put an error banner over the only screen where a human can
     * agree with the machine.
     */
    const [score, roster] = await Promise.all([
      api<TriageAccuracy>(`/triage/accuracy${query}`).catch(() => null),
      api<TriageCauseList>(`/triage/signatures${query}&muted=true`).catch(() => null),
    ]);
    setAccuracy(score);
    setMuted(roster);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function unmute(cause: TriageCause) {
    if (busyKey) return;
    setBusyKey(cause.clusterKey);
    setNote(null);
    try {
      await api(`/triage/signatures/${encodeURIComponent(cause.clusterKey)}/unmute`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
      setNote(`Un-muted. The next run of “${cause.label}” mints a verdict again.`);
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not un-mute that cause');
    } finally {
      setBusyKey(null);
    }
  }

  const live = muted?.causes.filter((cause) => cause.mute?.inForce) ?? [];
  // Nothing to say yet: no scorecard and no mutes is the state of a project on
  // its first day, and a header over two empty panels is worse than no header.
  if (!accuracy && live.length === 0) return null;

  return (
    <section className="border-line bg-surface-1 mt-5 rounded-lg border px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {accuracy && (
          <p className="text-body-sm min-w-0 flex-1">
            {/* Three sentences for three outcomes — see accuracyHeadline. The
                one that matters is "nobody has reviewed one", which must never
                come out as 0% overruled. */}
            {accuracyHeadline(accuracy.totals, accuracy.windowDays)}
            {accuracy.totals.minted > 0 && (
              <span className="text-ink-faint">
                {' '}
                {ratePercentLabel(accuracy.totals.reviewCoveragePercent)} of{' '}
                <span className="tabular-nums">{accuracy.totals.minted}</span> were ever looked at.
              </span>
            )}
          </p>
        )}
        {live.length > 0 && (
          <p className="text-flake text-body-sm">
            <span className="tabular-nums">{live.length}</span>{' '}
            {live.length === 1 ? 'cause is muted' : 'causes are muted'}
          </p>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-ink-faint hover:text-ink font-mono text-[10.5px] transition-colors"
        >
          {open ? 'hide' : 'details'}
        </button>
      </div>

      {open && (
        <div className="mt-3">
          {accuracy && (
            <>
              <SectionLabel className="mb-1.5">Per verdict kind</SectionLabel>
              <ul className="space-y-1">
                {accuracy.rows.map((row) => (
                  <li key={row.verdict} className="text-ink-dim text-micro leading-relaxed">
                    {/* The server's own sentence, printed verbatim. It already
                        says "accuracy is unmeasured, not good" when nobody has
                        reviewed one, which is the claim that matters. */}
                    <span className="text-ink font-mono">{row.verdict}</span> · {row.sentence}
                  </li>
                ))}
              </ul>
              <p className="text-ink-faint text-micro mt-2 leading-relaxed">{accuracy.caveat}</p>
            </>
          )}

          {live.length > 0 && (
            <div className={cn(accuracy && 'mt-4')}>
              <SectionLabel className="mb-1.5">Muted causes</SectionLabel>
              <ul className="space-y-2">
                {live.map((cause) => (
                  <li key={cause.clusterKey} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-body-sm min-w-0 flex-1">
                      {cause.label}
                      <span className="text-ink-faint">
                        {' · until '}
                        {new Date(cause.mute!.until).toLocaleDateString()}
                        {cause.mute!.reason ? ` · ${cause.mute!.reason}` : ''}
                        {/* What the silence has cost. A mute with a growing
                            suppressed count is a decision somebody should
                            re-make. */}
                        {cause.mute!.suppressed > 0 && (
                          <>
                            {' · '}
                            <span className="tabular-nums">{cause.mute!.suppressed}</span>{' '}
                            {cause.mute!.suppressed === 1 ? 'failure' : 'failures'} suppressed
                          </>
                        )}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyKey === cause.clusterKey}
                      disabled={busyKey !== null}
                      onClick={() => void unmute(cause)}
                    >
                      Un-mute
                    </Button>
                  </li>
                ))}
              </ul>
              {muted && capNote(muted) && (
                <p className="text-ink-faint text-micro mt-2">{capNote(muted)}</p>
              )}
            </div>
          )}

          {note && (
            <p role="status" className="text-ink-dim text-micro mt-3">
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
