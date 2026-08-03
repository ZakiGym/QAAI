'use client';

import Link from 'next/link';
import type { Run } from '../../lib/api';
import { cn } from '../../lib/cn';
import { SectionLabel, Skeleton } from '../ui/layout';

/**
 * NEEDS YOU — the only part of this screen that is a to-do list.
 *
 * Everything else on Runs home reports; this asks. It is deliberately three
 * kinds of thing and no more — a failure nobody has ruled on, a fix waiting for
 * approval, a test the flake radar is worried about — because a list that grows
 * a fourth category every quarter stops being a list of what needs you and
 * becomes a second inbox.
 *
 * Every row is built from a count the API already returns. Nothing here is
 * inferred, and a signal with no data behind it renders as nothing rather than
 * as a zero: "0 failures await a verdict" is a row asking for attention it does
 * not need.
 */

/** @see GET /projects/:id/flaky — the shape the Quality screen already reads. */
export interface FlakyTest {
  id: string;
  name: string;
  filePath: string;
  /** Percent, as the API reports it. */
  flakeRate: number;
  quarantined: boolean;
  lastRunAt: string | null;
}

export interface NeedsYouProps {
  /** GET /verdicts?state=PENDING — null while unknown, which is not zero. */
  pendingVerdicts: number | null;
  /** The most recent red run, so the faint half of the line can say where. */
  latestFailure: Run | null;
  /** GET /heals — proposals in PROPOSED, which is what that endpoint defaults to. */
  heals: number | null;
  /** Un-quarantined tests the radar has measured, worst first. */
  flaky: FlakyTest[];
  loading: boolean;
}

interface Signal {
  id: string;
  tone: string;
  lead: string;
  detail: string;
  action: { label: string; href: string };
}

export function NeedsYou({ pendingVerdicts, latestFailure, heals, flaky, loading }: NeedsYouProps) {
  const signals: Signal[] = [];

  if (pendingVerdicts !== null && pendingVerdicts > 0) {
    signals.push({
      id: 'verdicts',
      tone: 'bg-fail',
      lead: `${pendingVerdicts} ${pendingVerdicts === 1 ? 'failure awaits' : 'failures await'} a verdict`,
      detail: latestFailure
        ? `— latest from ${latestFailure.trigger.toLowerCase()} on ${latestFailure.environment.name}`
        : '— the agent ruled on each one; you get the last word',
      action: { label: 'triage →', href: '/triage' },
    });
  }

  if (heals !== null && heals > 0) {
    signals.push({
      id: 'heals',
      tone: 'bg-flake',
      lead: `${heals} heal ${heals === 1 ? 'proposal' : 'proposals'} ready`,
      detail: '— a diff per proposal, with the risk it carries stated up front',
      action: { label: 'review →', href: '/heals' },
    });
  }

  /*
   * One flake warning, not all of them. The radar's full list lives on Quality
   * and is the right place to work through it; what belongs here is the single
   * worst offender, because that is the one a person would act on today.
   */
  const worst = flaky.filter((t) => !t.quarantined).sort((a, b) => b.flakeRate - a.flakeRate)[0];
  if (worst) {
    signals.push({
      id: `flake-${worst.id}`,
      tone: 'bg-ink-faint',
      lead: `${worst.name} is ${worst.flakeRate.toFixed(0)}% flaky`,
      detail: '— quarantine it and it still runs, it just stops gating',
      action: { label: 'history →', href: `/tests/${worst.id}` },
    });
  }

  return (
    <section className="mt-9">
      <div className="flex items-baseline gap-2">
        <SectionLabel className="mb-0">Needs you</SectionLabel>
        {!loading && signals.length > 0 && (
          <span className="text-ink-faint text-micro font-mono tabular-nums">{signals.length}</span>
        )}
      </div>

      <div className="mt-1.5" aria-live="polite">
        {loading ? (
          <>
            {[0, 1].map((i) => (
              <div key={i} className="border-line flex items-center gap-3 border-b py-[11px]">
                <Skeleton className="h-1.5 w-1.5 rounded-full" />
                <Skeleton className="h-3 w-64" />
              </div>
            ))}
          </>
        ) : signals.length === 0 ? (
          // Not a boxed empty state: this is a short list on a busy page, and a
          // dashed panel for "nothing is wrong" would shout louder than the
          // three rows it replaces.
          <p className="border-line text-ink-faint text-row border-b py-[11px]">
            Nothing is waiting on you. Untriaged failures, heal proposals and a test the flake radar
            has flagged land here as they happen.
          </p>
        ) : (
          signals.map((signal) => (
            <div
              key={signal.id}
              className="border-line flex items-center gap-3 border-b py-[11px]"
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', signal.tone)} />
              <p className="text-row min-w-0 flex-1">
                <span className="font-semibold">{signal.lead}</span>
                <span className="text-ink-faint"> {signal.detail}</span>
              </p>
              <Link
                href={signal.action.href}
                className="text-accent shrink-0 text-[12.5px] hover:underline"
              >
                {signal.action.label}
              </Link>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
