'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import type { EvidenceResult, EvidenceStep } from '../EvidenceRail';
import { SeverityLabel, duration } from '../ui';
import { nearestErrorTo } from './evidence';

/**
 * The middle column: one test, told as what it did and where it stopped.
 *
 * A step timeline rather than a list of boxes. The steps a test took are a
 * sequence, and the one that matters is the one the sequence ends at — drawing
 * them against a rule with the failure expanded in place is the difference
 * between reading a story and reading a table.
 */

export interface FailureStoryProps {
  runId: string;
  result: EvidenceResult | null;
  selectedStep: number | null;
  onSelectStep: (index: number) => void;
}

export function FailureStory({ runId, result, selectedStep, onSelectStep }: FailureStoryProps) {
  if (!result) {
    return (
      <section className="min-h-0 overflow-y-auto px-8 py-6">
        <p className="text-ink-faint text-body-sm">
          Nothing selected. Pick a cause on the left and its first failing test opens here.
        </p>
      </section>
    );
  }

  return (
    <section className="min-h-0 overflow-y-auto px-8 py-6">
      {/* `break-words`: the third field is a file path, the column narrows to
          280px, and a path with no spaces in it will happily run out under the
          rail on the right. */}
      <p className="text-ink-faint font-mono text-[10.5px] tracking-[0.08em] break-words">
        {result.test.type.toUpperCase()} · {result.test.priority.replace(/_/g, ' ')} ·{' '}
        {/* This was dead text on the highest-traffic triage screen while /heals
            and /triage both made the same string a link. It goes to the test's
            own history, which answers the question you ask next: has this always
            been unreliable? */}
        <Link
          href={`/tests/${result.test.id}`}
          className="hover:text-ink transition-colors"
          title="This test's history"
        >
          {result.test.filePath}
        </Link>
      </p>

      {/*
        h1, not h2. The cockpit has no PageHeader — its header is a chip, an id
        and a gate state — so this was the first heading on the page and the
        document began at level 2 with no h1 at all. Someone arriving here with
        a screen reader got a run's worth of detail and no page title. The name
        of the failing test IS what this screen is about, so it is the title.
      */}
      <h1 className="font-display text-display-sm mt-2 leading-[1.25] font-semibold tracking-[-0.005em]">
        {result.test.name}
      </h1>

      <p className="text-ink-faint mt-2 text-[12.5px]">
        <span className="tabular-nums">{duration(result.durationMs)}</span> ·{' '}
        <Link href={`/tests/${result.test.id}`} className="text-accent hover:underline">
          history
        </Link>
        {/* Only when this result kept a trace — sending someone to a viewer that
            has to explain there is nothing to view is worse than no link. */}
        {result.traceKey && (
          <>
            {' · '}
            <Link
              href={`/runs/${runId}/trace?result=${result.id}`}
              className="text-accent hover:underline"
              title="Step through this test's recorded browser session"
            >
              trace
            </Link>
          </>
        )}
      </p>

      {result.retriedAndPassed && (
        <p className="border-flake/40 text-flake mt-4 rounded-lg border bg-[color-mix(in_srgb,var(--color-flake)_10%,transparent)] p-3 text-[12.5px]">
          This test failed and then passed on retry. A retry that passes is not a pass — it is a
          flake candidate, and the gate treats it as one.
        </p>
      )}

      {result.steps.length > 0 ? (
        <ol className="border-line mt-6 ml-1 border-l">
          {result.steps.map((step) => (
            <TimelineStep
              key={step.id}
              step={step}
              result={result}
              selected={selectedStep === step.index}
              onSelect={() => onSelectStep(step.index)}
            />
          ))}
        </ol>
      ) : (
        result.errorMessage && (
          /* Some runners report no steps at all. The error is then the whole of
             what happened, and it gets the expansion's treatment on its own. */
          <pre className="border-fail/30 text-ink-dim mt-6 overflow-x-auto rounded-lg border bg-[color-mix(in_srgb,var(--color-fail)_6%,transparent)] p-4 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap">
            {result.errorMessage}
          </pre>
        )
      )}

      {result.findings.length > 0 && (
        <section className="mt-8">
          <h3 className="text-ink-faint text-meta mb-2 font-mono font-semibold tracking-[0.1em] uppercase">
            Findings <span className="tabular-nums">{result.findings.length}</span>
          </h3>
          <ul>
            {result.findings.map((finding) => (
              <li key={finding.id} className="border-line border-b py-3">
                <div className="flex items-center gap-2">
                  <SeverityLabel severity={finding.severity} />
                  <code className="text-ink-faint font-mono text-meta">{finding.code}</code>
                </div>
                <p className="text-ink-dim mt-1 text-[12.5px]">{finding.message}</p>
                <p className="text-ink-faint mt-0.5 font-mono text-meta">{finding.location}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function TimelineStep({
  step,
  result,
  selected,
  onSelect,
}: {
  step: EvidenceStep;
  result: EvidenceResult;
  selected: boolean;
  onSelect: () => void;
}) {
  const failed = step.status === 'FAILED';
  // The failure expands wherever it is; any other step expands only when it is
  // the one being looked at, and only if it has something to expand.
  const expanded = failed || (selected && Boolean(step.errorMessage || step.expected || step.actual));

  const dot = failed ? 'bg-fail' : step.status === 'PASSED' ? 'bg-pass' : 'bg-skip';

  return (
    <li className="relative py-2 pr-0 pl-[22px]">
      {/* Ringed in the page background, so the dot sits ON the rule rather than
          beside it — that ring is the whole reason the timeline reads as one
          thread instead of a column of bullets. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-[13px] -left-[5px] h-[9px] w-[9px] rounded-full shadow-[0_0_0_3px_var(--color-surface)]',
          dot,
          selected && 'ring-accent ring-2',
        )}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex w-full items-baseline gap-3 text-left"
      >
        <span
          className={cn('text-row flex-1', failed ? 'text-ink font-semibold' : 'text-ink-dim')}
        >
          {step.title}
        </span>
        <span className="text-ink-faint shrink-0 font-mono text-micro tabular-nums">
          {duration(step.durationMs)}
        </span>
      </button>

      {expanded && <StepDetail step={step} result={result} />}
    </li>
  );
}

/** The failure, in place: what was expected, what happened, and the error. */
function StepDetail({ step, result }: { step: EvidenceStep; result: EvidenceResult }) {
  const hint = useHint(step, result);

  return (
    <div className="border-fail/30 mt-2.5 rounded-lg border bg-[color-mix(in_srgb,var(--color-fail)_6%,transparent)] px-4 py-3.5">
      {(step.expected || step.actual) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[12.5px]">
          <dt className="text-ink-faint">expected</dt>
          <dd className="text-pass break-words tabular-nums">{step.expected ?? '—'}</dd>
          <dt className="text-ink-faint">actual</dt>
          <dd className="text-fail break-words tabular-nums">{step.actual ?? '—'}</dd>
        </dl>
      )}

      {step.selector && (
        <p className="text-ink-faint mt-2 font-mono text-micro break-all">
          selector <span className="text-ink-dim">{step.selector}</span>
        </p>
      )}

      {step.errorMessage && (
        <pre className="text-ink-dim mt-3 overflow-x-auto font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap">
          {step.errorMessage}
        </pre>
      )}

      {hint && <p className="text-ink-faint mt-2.5 text-[11.5px]">{hint}</p>}
    </div>
  );
}

/**
 * The sentence that points at the rail.
 *
 * Both halves are computed, never written: the gap is arithmetic on the two
 * numbers directly above it, and the console clause only appears when there is
 * an error in the log to point at. A hint that says "check the console" when
 * the console is empty teaches people to ignore hints.
 */
function useHint(step: EvidenceStep, result: EvidenceResult): string | null {
  const consoleLog = useMemo(() => result.consoleLog ?? [], [result.consoleLog]);
  const nearest = useMemo(() => nearestErrorTo(consoleLog, step), [consoleLog, step]);

  const expected = Number(step.expected);
  const actual = Number(step.actual);
  const numeric =
    step.expected !== null &&
    step.actual !== null &&
    Number.isFinite(expected) &&
    Number.isFinite(actual) &&
    expected !== actual;

  const parts: string[] = [];
  if (numeric) parts.push(`The gap is ${Math.abs(expected - actual)}.`);
  if (nearest) {
    parts.push(
      nearest.label && nearest.label !== 'during'
        ? `A console error was logged ${nearest.label.replace('−', '')} before this step — it is in the triage rail.`
        : 'A console error was logged during this step — it is in the triage rail.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
