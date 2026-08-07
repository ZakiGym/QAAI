'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { API_URL, api } from '../../lib/api';
import { Button } from '../ui/Button';
import { SectionLabel } from '../ui/layout';
import { clock } from '../setup/time';

/**
 * The Explorer, live.
 *
 * Lifted out of the old onboarding page with its behaviour intact, because
 * every part of that behaviour was earned by a specific failure and none of it
 * should be re-derived:
 *
 *  - The elapsed clock and the quiet counter answer two different questions.
 *    "Is it stuck?" is elapsed; "has it stopped?" is time since the last line.
 *    A log that has not moved for ninety seconds is indistinguishable from a
 *    dead worker, and people reloaded and started a second crawl.
 *  - The give-up timer asks the flow map WHY before it says anything. It used
 *    to assert "the crawl did not finish", and the commonest way to reach it
 *    was a crawl that had finished perfectly and was already in the database.
 *  - The teardown is returned and held, because dropping it let the five-minute
 *    timer fire after a successful crawl and flip someone reading their plan
 *    back to an error.
 */

/** How long without a new log line before the screen says so, in ms. */
const QUIET_MS = 20_000;

export type CrawlPhase = 'crawling' | 'stopped' | 'done' | 'error';

export function CrawlPanel({
  projectId,
  baseUrl,
  onError,
}: {
  projectId: string;
  baseUrl: string;
  /** Raised when the crawl cannot be accounted for; the page owns the message. */
  onError: (message: string) => void;
}) {
  const [phase, setPhase] = useState<CrawlPhase>('crawling');
  const [log, setLog] = useState<string[]>([`Crawling ${baseUrl}…`]);
  const [startedAt] = useState(() => Date.now());
  const [lastLogAt, setLastLogAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLDivElement>(null);

  const stopWatchingRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatchingRef.current?.(), []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    setLastLogAt(Date.now());
  }, [log]);

  // Ticks only while something is actually in flight.
  useEffect(() => {
    if (phase !== 'crawling') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const follow = useCallback(() => {
    const source = new EventSource(`${API_URL}/projects/${projectId}/explore/events`, {
      withCredentials: true,
    });

    source.addEventListener('log', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as {
          data: { message?: string };
        };
        if (parsed.data.message) setLog((prev) => [...prev, parsed.data.message!].slice(-200));
      } catch {
        /* ignore a malformed frame */
      }
    });

    // The crawl ends by writing a plan. Poll for it too, in case the event is
    // missed — an SSE frame lost to a proxy should not strand the screen.
    source.addEventListener('run.finished', () => {
      stop();
      setPhase('done');
    });

    const poll = setInterval(() => {
      void api<{ plan: { items: unknown[] } }>(`/projects/${projectId}/plan`)
        .then(() => {
          stop();
          setPhase('done');
        })
        .catch(() => {
          /* no plan yet — that is the normal case while crawling */
        });
    }, 3000);

    const giveUp = setTimeout(() => {
      stop();
      void api<{ flowMap: { version: number; nodeCount: number } }>(
        `/projects/${projectId}/flow-map`,
      )
        .then((result) => {
          onError(
            `The crawl finished — flow map v${result.flowMap.version}, ${result.flowMap.nodeCount} states — but no test plan was written from it. That step runs in the worker: check that it is running and read its log for the reason.`,
          );
        })
        .catch(() => {
          onError(
            'The crawl did not finish and no flow map was written. Is the worker running? Its log will say what stopped.',
          );
        })
        .finally(() => setPhase('error'));
    }, 5 * 60_000);

    function stop() {
      clearInterval(poll);
      clearTimeout(giveUp);
      source.close();
    }

    return stop;
  }, [projectId, onError]);

  useEffect(() => {
    stopWatchingRef.current = follow();
    return () => {
      stopWatchingRef.current?.();
      stopWatchingRef.current = null;
    };
  }, [follow]);

  const quietFor = phase === 'crawling' ? Math.floor((now - lastLogAt) / 1000) : 0;

  return (
    <div>
      <SectionLabel>
        Explorer{' '}
        <span className={phase === 'done' ? 'text-pass' : undefined}>
          ·{' '}
          {phase === 'crawling'
            ? 'live'
            : phase === 'done'
              ? 'finished'
              : phase === 'stopped'
                ? 'not watching'
                : 'stopped'}
        </span>
        {phase === 'crawling' && (
          <span className="bg-accent ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle" />
        )}
      </SectionLabel>

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        className="border-line bg-surface-1 max-h-[220px] overflow-y-auto rounded-lg border px-3.5 py-3 font-mono text-[10.5px] leading-[1.8]"
      >
        {log.map((line, i) => (
          <p key={i} className={i === log.length - 1 ? 'text-ink-dim' : 'text-ink-faint'}>
            {line}
          </p>
        ))}
      </div>

      {phase === 'crawling' && (
        <>
          <p className="text-ink-faint text-micro mt-2.5 font-mono tabular-nums" aria-live="polite">
            {log.length} line{log.length === 1 ? '' : 's'} · {clock(now - startedAt)} · stops at 5m
            or when the frontier is empty
            {quietFor >= QUIET_MS / 1000 && (
              <span className="text-flake"> · still going — nothing new for {quietFor}s</span>
            )}
          </p>
          <p className="mt-2">
            <button
              type="button"
              onClick={() => {
                stopWatchingRef.current?.();
                stopWatchingRef.current = null;
                setPhase('stopped');
              }}
              className="text-ink-faint hover:text-ink text-[12px] transition-colors"
            >
              stop watching
            </button>
          </p>
        </>
      )}

      {phase === 'stopped' && (
        <div className="mt-2.5">
          <p className="text-ink-dim text-row-sub leading-relaxed">
            Stopped watching. The crawl itself keeps running in the worker — nothing was cancelled,
            and the flow map fills in when it finishes.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                setPhase('crawling');
                setNow(Date.now());
                stopWatchingRef.current = follow();
              }}
            >
              Watch again
            </Button>
            <Link
              href="/flow-map"
              className="border-line text-ink-dim hover:text-ink hover:border-line-strong inline-flex items-center rounded-md border px-[11px] py-[5px] text-[12px] transition-colors"
            >
              Open the flow map
            </Link>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="mt-3">
          <Link
            href={`/projects/${projectId}/plan`}
            className="bg-accent text-accent-ink text-row-sub inline-block rounded-md px-3.5 py-[7px] font-semibold hover:opacity-90"
          >
            Review the proposed plan →
          </Link>
          <p className="text-ink-faint text-micro mt-2 leading-relaxed">
            The crawl needed no API key. Turning the plan into code does — except for the
            spec-driven types, which QAAI scaffolds from the crawl on its own.
          </p>
        </div>
      )}

      {/* The error phase keeps the log. It is the only record of the crawl the
          screen has, and the old page threw it away with the form. */}
      {phase === 'error' && (
        <p className="text-ink-faint text-micro mt-2.5 font-mono">
          the log above is what the crawl reported before it stopped
        </p>
      )}
    </div>
  );
}
