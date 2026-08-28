'use client';

import { useEffect, useState } from 'react';
import { summariseFailure, type FailureKind, type FailureLocation } from '@qaai/shared';
import { api, type TestResult } from '../../lib/api';
import type { EvidenceResult } from '../EvidenceRail';
import { Badge } from '../ui/layout';

/**
 * "Why did it fail", above everything else on a red run.
 *
 * The cockpit already shows a stack, a message and a trace, and the reader has
 * been doing the translation from those into a sentence. This is the sentence:
 * what broke in the words of the assertion, where, what KIND of failure it is,
 * whether it looks flaky, and the first move when the kind implies one.
 *
 * The whole thing comes out of `summariseFailure` in @qaai/shared, which is
 * pattern work over text the runner already controls — no model, no key, and
 * the same answer on every deployment. Everything below is rendering.
 *
 * There is no heading element here on purpose. This box mounts above
 * FailureStory, whose h1 is the failing test's name, and an h2 sitting in front
 * of that h1 would put the document's heading order out for every screen
 * reader that walks it. The label is styled like the meta lines the cockpit
 * already uses instead.
 */

/**
 * `GET /tests/:testId/history` — the columns this box needs. lib/api.ts does
 * not describe this endpoint, so the shape is declared next to its only reader
 * here, the way the cockpit already declares its shard types.
 */
interface HistoryResponse {
  results: Array<{
    id: string;
    status: TestResult['status'];
    retriedAndPassed: boolean;
    run: { id: string };
  }>;
}

/**
 * Amber for the kinds where the application under test is not the accused —
 * a missing binary, a refused connection, a spec that never produced a case.
 * Red is reserved for a failure that is genuinely about the product, because a
 * red chip over "k6 is not installed" is how a worker problem gets filed as a
 * bug three times in a row.
 */
export const KIND_TONE: Record<FailureKind, 'fail' | 'flake' | 'neutral'> = {
  ENVIRONMENT: 'flake',
  FIXTURE: 'flake',
  CRASH: 'flake',
  NETWORK: 'flake',
  NAVIGATION: 'fail',
  SELECTOR_AMBIGUOUS: 'fail',
  ELEMENT_STATE: 'fail',
  SELECTOR_NOT_FOUND: 'fail',
  PAGE_ERROR: 'fail',
  VISUAL_DIFF: 'fail',
  ACCESSIBILITY: 'fail',
  SECURITY: 'fail',
  CONTRACT: 'fail',
  BUDGET: 'fail',
  ASSERTION: 'fail',
  TIMEOUT: 'fail',
  UNKNOWN: 'neutral',
};

export interface FailureSummaryProps {
  runId: string;
  result: EvidenceResult | null;
}

export function FailureSummary({ runId, result }: FailureSummaryProps) {
  const previousOutcome = usePreviousOutcome(runId, result?.test.id ?? null);

  if (!result) return null;

  const summary = summariseFailure({
    status: result.status,
    testType: result.test.type,
    errorMessage: result.errorMessage,
    retriedAndPassed: result.retriedAndPassed,
    steps: result.steps,
    filePath: result.test.filePath,
    findings: result.findings,
    previousOutcome,
  });

  // Null on a clean pass. The box exists to answer a question a green result
  // does not raise.
  if (!summary) return null;

  const tone = KIND_TONE[summary.kind];

  return (
    <section
      aria-label="Why this failed"
      className={
        // The tone lives in the border and a 6% wash, matching the failure
        // expansions in the timeline below — one visual language for "this is
        // the broken part" across the whole column.
        tone === 'flake'
          ? 'border-flake/40 rounded-lg border bg-[color-mix(in_srgb,var(--color-flake)_7%,transparent)] px-5 py-4'
          : tone === 'fail'
            ? 'border-fail/40 rounded-lg border bg-[color-mix(in_srgb,var(--color-fail)_7%,transparent)] px-5 py-4'
            : 'border-line bg-surface-2 rounded-lg border px-5 py-4'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-faint font-mono text-[10.5px] font-semibold tracking-[0.12em] uppercase">
          Why it failed
        </span>
        <Badge tone={tone} tint>
          {summary.kindLabel}
        </Badge>
      </div>

      {/*
        The sentence. `break-words` because a headline is frequently a locator
        or a URL with no spaces in it, and this column narrows.
      */}
      <p className="text-ink text-body mt-2.5 leading-[1.45] font-medium break-words">
        {summary.headline}
      </p>

      <Where location={summary.location} />

      {/*
        The raw error, but only when nothing recognised it. When the kind IS
        known the headline has already said it in fewer words, and repeating the
        stack here would undo the entire point of the box.
      */}
      {!summary.classified && summary.raw && (
        <>
          <p className="text-ink-faint mt-3 text-[11.5px]">
            QAAI does not recognise this failure, so here it is unedited rather than guessed at.
          </p>
          <pre className="text-ink-dim border-line mt-1.5 max-h-40 overflow-auto rounded-md border p-3 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap">
            {summary.raw}
          </pre>
        </>
      )}

      {summary.nextAction && (
        <p className="border-line/70 text-ink-dim mt-3 border-t pt-3 text-[12.5px] leading-[1.5]">
          <span className="text-ink-faint font-mono text-[10.5px] tracking-[0.1em] uppercase">
            First move
          </span>{' '}
          {summary.nextAction}
        </p>
      )}

      {summary.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {summary.notes.map((note) => (
            <li
              key={note.signal}
              className={`text-[12.5px] leading-[1.5] ${note.looksFlaky ? 'text-flake' : 'text-ink-dim'}`}
            >
              {note.sentence}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Step, file, line, locator — whichever of them the runner actually recorded. */
function Where({ location }: { location: FailureLocation }) {
  const parts: string[] = [];
  if (location.step) parts.push(`step ${location.step.index + 1} · ${location.step.title}`);
  if (location.file) parts.push(location.line ? `${location.file}:${location.line}` : location.file);

  if (parts.length === 0 && !location.selector) return null;

  return (
    <p className="text-ink-faint mt-1.5 font-mono text-[11px] break-all">
      {parts.join('  ·  ')}
      {location.selector && (
        <>
          {parts.length > 0 && <br />}
          <span className="text-ink-dim">{location.selector}</span>
        </>
      )}
    </p>
  );
}

/**
 * How this same test ended on the previous run that executed it.
 *
 * Fetched rather than derived, because the run payload holds one run and the
 * question is about two. It is deliberately not blocking: the headline and the
 * kind are available the instant the result is, and the reliability line
 * appears a beat later when the history lands. A failed history request leaves
 * the outcome null, which makes the module say nothing about flakiness at all —
 * the correct behaviour, since we then genuinely do not know.
 */
function usePreviousOutcome(runId: string, testId: string | null): TestResult['status'] | null {
  const [outcome, setOutcome] = useState<TestResult['status'] | null>(null);

  useEffect(() => {
    setOutcome(null);
    if (!testId) return;

    let cancelled = false;
    void (async () => {
      try {
        const history = await api<HistoryResponse>(`/tests/${testId}/history?limit=10`);
        if (cancelled) return;
        // Newest-first, and the newest entry is this run's own result. A run can
        // hold more than one result for a test, so every row from this run is
        // skipped rather than just the first.
        const earlier = history.results.find((r) => r.run.id !== runId);
        if (!earlier) return;
        // §5, the same rule the gate and the history strip apply: a retry that
        // passed is not a pass, so it must not read as "it was green before".
        setOutcome(earlier.status === 'PASSED' && earlier.retriedAndPassed ? 'FLAKY' : earlier.status);
      } catch {
        // Nothing to say is better than a wrong claim about history.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, testId]);

  return outcome;
}
