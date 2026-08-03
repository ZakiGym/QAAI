'use client';

import { useCallback, useMemo, useState } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  type RedactionKind,
  type TrafficAnalysis,
  type TrafficJourney,
  type TrafficProposal,
} from '../../lib/api';
import { duration, relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { TrafficUpload } from '../../components/TrafficUpload';
import { TestsHeader } from '../../components/TestsHeader';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { Page, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Tests from production traffic (§8).
 *
 * The argument the whole screen makes is one number: the share of real sessions
 * that walk a journey. A suite written from a spec tests what someone imagined
 * users do; a suite written from this tests what they did. So the percentage is
 * the largest thing in every row — serif, because it is the headline — and the
 * ranking is never re-sorted client-side: the API already ranked it and the
 * order IS the recommendation.
 *
 * THE REDACTION SUMMARY COMES FIRST, before the journeys, before the totals.
 * A customer is uploading production traffic to a vendor. Until they know
 * exactly what was stripped, and that it was stripped on the way in rather than
 * hidden on the way out, nothing further down the page has earned a reading.
 * Every category is listed including the ones that came back zero, and a zero
 * is printed in the pass colour: "we looked for card numbers and found none" is
 * a different statement from silence.
 */

const REDACTION_ORDER: RedactionKind[] = [
  'CARD_NUMBER',
  'NATIONAL_ID',
  'EMAIL',
  'PHONE',
  'JWT',
  'OPAQUE_TOKEN',
  'COOKIE',
  'HEADER',
  'IP_ADDRESS',
  'USER_AGENT',
  'USER_IDENTIFIER',
  'PATH_IDENTIFIER',
  'QUERY_VALUE',
  'URL_CREDENTIALS',
  'REQUEST_BODY',
  'RESPONSE_BODY',
];

/** Short enough for a four-column mono grid, and still the thing it is. */
const REDACTION_LABEL: Record<RedactionKind, string> = {
  REQUEST_BODY: 'request bodies',
  RESPONSE_BODY: 'response bodies',
  HEADER: 'header values',
  COOKIE: 'cookies',
  QUERY_VALUE: 'query values',
  URL_CREDENTIALS: 'url credentials',
  IP_ADDRESS: 'client IPs',
  USER_AGENT: 'user agents',
  USER_IDENTIFIER: 'user ids',
  EMAIL: 'emails',
  PHONE: 'phone numbers',
  CARD_NUMBER: 'card numbers',
  NATIONAL_ID: 'national ids',
  JWT: 'JWTs',
  OPAQUE_TOKEN: 'opaque tokens',
  PATH_IDENTIFIER: 'path ids',
};

const FORMAT_LABEL: Record<string, string> = {
  HAR: 'HAR',
  ACCESS_LOG: 'Access log',
  OTLP: 'OTLP spans',
};

const COVERAGE: Record<
  TrafficJourney['coverage']['status'],
  { chip: string; tone: string; blurb: string }
> = {
  COVERED: {
    chip: 'COVERED',
    tone: 'text-pass bg-[color-mix(in_srgb,var(--color-pass)_12%,transparent)]',
    blurb: 'A test in your suite already walks this. Proposing it again duplicates work.',
  },
  PARTIAL: {
    chip: 'PARTIAL',
    tone: 'text-flake bg-[color-mix(in_srgb,var(--color-flake)_13%,transparent)]',
    blurb: 'Some steps are tested and some are not.',
  },
  UNCOVERED: {
    chip: 'NOT COVERED',
    tone: 'text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
    blurb: 'Nothing in your suite mentions these routes.',
  },
};

function pct(share: number): string {
  const value = share * 100;
  return value >= 9.5 ? `${Math.round(value)}` : value.toFixed(1);
}

function count(n: number): string {
  return n.toLocaleString();
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function TrafficPage() {
  const router = useRouter();
  const { project, projects, loading: projectsLoading } = useProject();
  const toast = useToast();

  const [analysis, setAnalysis] = useState<TrafficAnalysis | null>(null);
  /** What the analysis came from. The payload itself does not carry a filename. */
  const [source, setSource] = useState<{ name: string; at: string } | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [reuploading, setReuploading] = useState(false);
  const [proposing, setProposing] = useState<string | null>(null);
  const [proposal, setProposal] = useState<TrafficProposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);

  const uncovered = useMemo(
    () => (analysis?.journeys ?? []).filter((j) => j.coverage.status !== 'COVERED'),
    [analysis],
  );

  /** One place decides that a 401 means "sign in", not "your file is bad". */
  const describe = useCallback(
    (err: unknown, fallback: string): string | null => {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return null;
      }
      return err instanceof Error ? err.message : fallback;
    },
    [router],
  );

  /**
   * Turn journeys into an approved plan.
   *
   * `key` is only what to show a spinner on — a row id, or `all` for the bulk
   * action. The journeys go back to the API exactly as they arrived: it
   * recomputes each id from its steps and refuses the request if they disagree,
   * so trimming or "tidying" one here would fail the whole batch.
   */
  const propose = useCallback(
    async (key: string, journeys: TrafficJourney[], includeCovered = false) => {
      if (!project || !analysis || journeys.length === 0) return;
      setProposing(key);
      setProposeError(null);
      setProposal(null);
      try {
        const result = await api<TrafficProposal>(`/traffic/${project.id}/propose`, {
          method: 'POST',
          body: JSON.stringify({
            journeys,
            totalSessions: analysis.totals.sessions,
            source: analysis.format,
            ...(includeCovered ? { includeCovered: true } : {}),
          }),
        });
        setProposal(result);
        if (result.accepted > 0) {
          toast.success(
            `${result.accepted} test${result.accepted === 1 ? '' : 's'} queued for generation.`,
          );
        }
      } catch (err) {
        const message = describe(err, 'The proposal was refused.');
        if (message) {
          setProposeError(message);
          toast.error(message);
        }
      } finally {
        setProposing(null);
      }
    },
    [project, analysis, describe, toast],
  );

  if (projectsLoading) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[900px] px-10 pt-8">
          <Skeleton className="h-40 w-full" />
        </div>
      </Page>
    );
  }

  if (!project) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
          <EmptyState
            title="Journeys from your production traffic"
            body={
              projects.length === 0
                ? 'Upload a HAR, an access log or an OTLP export and QAAI ranks the journeys your users actually walk, then writes tests for the ones your suite misses. It needs an app to analyse first.'
                : 'Choose an app in the sidebar — the analysis is cross-referenced against that app’s suite.'
            }
            {...(projects.length === 0
              ? { action: { label: 'Add an app', href: '/onboarding' } }
              : {})}
          />
        </div>
      </Page>
    );
  }

  const showUpload = !analysis || reuploading;

  return (
    <Page width="full">
      <TestsHeader />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-10 pt-8 pb-16">
          {analysis && !analysing && (
            <p className="text-ink-faint font-mono text-[10.5px] leading-relaxed">
              {source?.name ?? 'upload'} ·{' '}
              <span className="tabular-nums">{count(analysis.totals.requests)}</span> requests ·
              analysed {source ? relativeTime(source.at) : 'just now'} ·{' '}
              <button
                type="button"
                onClick={() => setReuploading((open) => !open)}
                className="text-accent hover:underline"
              >
                {reuploading ? 'keep this one' : 'upload new'}
              </button>
            </p>
          )}

          {showUpload && (
            <div className={analysis ? 'mt-4' : undefined}>
              {!analysis && (
                <p className="text-ink-dim mb-4 text-[13.5px] leading-relaxed">
                  Upload a HAR, an access log or an OTLP export from {project.name} — QAAI ranks the
                  journeys your users actually walk, checks them against your suite, and writes
                  tests for what is missing.
                </p>
              )}
              <TrafficUpload
                projectId={project.id}
                busy={analysing}
                onStart={() => {
                  setAnalysing(true);
                  setAnalysis(null);
                  setSource(null);
                  setProposal(null);
                  setProposeError(null);
                }}
                onAnalysed={(next, fileName) => {
                  setAnalysing(false);
                  setReuploading(false);
                  setAnalysis(next);
                  setSource({ name: fileName, at: new Date().toISOString() });
                  if (next.journeys.length > 0) {
                    toast.success(
                      `${next.journeys.length} journeys across ${count(next.totals.sessions)} sessions.`,
                    );
                  }
                }}
                onError={(err) => {
                  setAnalysing(false);
                  const message = describe(err, 'The upload could not be analysed.');
                  if (message) toast.error(message);
                }}
              />
            </div>
          )}

          {/* Never the empty state while a request is in flight. */}
          {analysing && (
            <div className="mt-8 space-y-3" role="status" aria-label="Analysing the upload">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-24 w-full" />
              <p className="text-ink-faint text-center text-[11px] leading-relaxed">
                Redacting on ingest, sessionising, then ranking. No model is involved — this is
                arithmetic over your upload.
              </p>
            </div>
          )}

          {analysis && !analysing && (
            <>
              <Redaction analysis={analysis} />

              <section className="mt-7">
                <div className="flex flex-wrap items-baseline gap-3">
                  <h3 className="text-micro text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
                    Journeys · ranked by real sessions
                  </h3>
                  {uncovered.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void propose('all', uncovered)}
                      disabled={proposing !== null}
                      className="text-accent ml-auto text-[11.5px] hover:underline disabled:opacity-60"
                    >
                      {proposing === 'all'
                        ? 'proposing…'
                        : `propose the ${uncovered.length} your suite misses →`}
                    </button>
                  )}
                </div>

                {analysis.journeys.length === 0 ? (
                  <div className="mt-3">
                    <EmptyState
                      title="No journey appeared more than once"
                      body="Every session in this upload walked a different path, so there is no repeated journey to rank. That usually means the window is too short, or the traffic is bots rather than people — try a longer capture."
                    />
                  </div>
                ) : (
                  <>
                    <div className="mt-1.5">
                      {analysis.journeys.map((journey) => (
                        <JourneyRow
                          key={journey.id}
                          journey={journey}
                          totalSessions={analysis.totals.sessions}
                          busy={proposing === journey.id}
                          disabled={proposing !== null}
                          onPropose={(includeCovered) =>
                            void propose(journey.id, [journey], includeCovered)
                          }
                        />
                      ))}
                    </div>
                    <p className="text-ink-faint mt-2.5 font-mono text-[10.5px]">
                      ranked by the API — the order is the recommendation
                    </p>
                  </>
                )}

                {proposeError && (
                  <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--color-fail)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3.5">
                    <p className="text-fail text-[12.5px] leading-relaxed">{proposeError}</p>
                  </div>
                )}

                {proposal && <ProposalResult proposal={proposal} projectId={project.id} />}
              </section>

              <Ingest analysis={analysis} />
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

// ─── Redaction: the first thing on the page ──────────────────────────────────

function Redaction({ analysis }: { analysis: TrafficAnalysis }) {
  const { redaction } = analysis;

  return (
    <section className="border-line mt-[18px] rounded-lg border px-[18px] py-4">
      <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
        Redacted on ingest — before storage
      </h3>

      <div className="mt-2.5 grid grid-cols-2 gap-x-[18px] gap-y-1.5 font-mono text-[10.5px] sm:grid-cols-4">
        {REDACTION_ORDER.map((kind) => {
          const n = redaction.counts[kind] ?? 0;
          return (
            <span key={kind} className="text-ink-dim">
              {REDACTION_LABEL[kind]}{' '}
              {/* A zero is an answer, and it is the good one — it gets the pass
                  colour rather than being dimmed out of the way. */}
              <span className={cn('tabular-nums', n === 0 ? 'text-pass' : 'text-ink')}>
                {count(n)}
              </span>
            </span>
          );
        })}
      </div>

      <p className="text-ink-faint mt-2.5 text-[11.5px] leading-relaxed">
        Every category we look for is listed, including the zeros — &ldquo;we found none&rdquo; is a
        different statement from silence.
      </p>

      <div className="border-line mt-3.5 border-t pt-3">
        <p className="text-ink-faint font-mono text-[10.5px]">never read at all</p>
        {/* A sentence rather than chips: these strings run from two words to a
            full parenthetical, and a row of badges that wide reads as noise. */}
        <p className="text-ink-dim mt-1 text-[12px] leading-relaxed">
          {redaction.neverRead.join(', ')}. A stronger guarantee than masking: these were not
          opened, so there is nothing to have leaked.
        </p>
      </div>

      {redaction.queryParamNamesKept.length > 0 && (
        <div className="border-line mt-3 border-t pt-3">
          <p className="text-ink-faint font-mono text-[10.5px]">
            query parameter names kept — their values were not
          </p>
          <p className="text-ink-dim mt-1 font-mono text-[11px] break-words">
            {redaction.queryParamNamesKept.join(' · ')}
          </p>
        </div>
      )}

      <div className="border-line mt-3 space-y-1.5 border-t pt-3">
        <p className="text-ink-faint text-[11px] leading-relaxed">{redaction.when}.</p>
        <p className="text-ink-faint text-[11px] leading-relaxed">{redaction.identityHashing}</p>
        <p className="text-ink-faint text-[11px] leading-relaxed">{redaction.note}</p>
      </div>
    </section>
  );
}

// ─── One journey ─────────────────────────────────────────────────────────────

function JourneyRow({
  journey,
  totalSessions,
  busy,
  disabled,
  onPropose,
}: {
  journey: TrafficJourney;
  totalSessions: number;
  busy: boolean;
  disabled: boolean;
  onPropose: (includeCovered: boolean) => void;
}) {
  const coverage = COVERAGE[journey.coverage.status];
  const covered = journey.coverage.status === 'COVERED';
  const [detail, setDetail] = useState(false);

  return (
    <div className="border-line border-b py-3.5">
      <div className="flex items-center gap-4">
        <span className="font-display w-[74px] shrink-0 text-[26px] leading-none font-semibold tabular-nums">
          {pct(journey.sessionShare)}
          <span className="text-ink-dim text-[15px]">%</span>
        </span>

        <button
          type="button"
          onClick={() => setDetail((open) => !open)}
          aria-expanded={detail}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13.5px]">{journey.feature}</span>
          <span className="text-ink-faint mt-0.5 block font-mono text-[10.5px] tabular-nums">
            {count(journey.sessionCount)} of {count(totalSessions)} sessions
            {journey.coverage.missingSteps.length > 0 &&
              ` · gap: ${journey.coverage.missingSteps.slice(0, 2).join(', ')}`}
          </span>
        </button>

        <span
          className={cn(
            'shrink-0 rounded-sm px-[7px] py-[2px] font-mono text-[10px] tracking-[0.05em]',
            coverage.tone,
          )}
        >
          {coverage.chip}
        </span>

        {covered ? (
          <span className="text-ink-faint shrink-0 font-mono text-[10.5px] whitespace-nowrap">
            duplicates work ·{' '}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPropose(true)}
              className="text-accent hover:underline disabled:opacity-60"
            >
              {busy ? 'proposing…' : 'anyway'}
            </button>
          </span>
        ) : (
          <Button
            variant={journey.coverage.status === 'PARTIAL' ? 'secondary' : 'primary'}
            size="sm"
            loading={busy}
            disabled={disabled && !busy}
            onClick={() => onPropose(false)}
          >
            {journey.coverage.status === 'PARTIAL' ? 'Fill the gap' : 'Propose test'}
          </Button>
        )}
      </div>

      {detail && (
        <div className="mt-2.5 pl-[90px]">
          <ol className="flex flex-wrap items-center gap-1.5">
            {journey.steps.map((step, i) => (
              <li key={`${step.method}-${step.route}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-ink-faint text-[10px]">→</span>}
                <span className="border-line bg-surface-2 inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[10.5px]">
                  <span className="text-ink-faint">{step.method}</span>
                  <span className="text-ink">{step.route}</span>
                  {step.status !== null && (
                    <span
                      className={cn(
                        'tabular-nums',
                        step.status >= 400 ? 'text-fail' : 'text-ink-faint',
                      )}
                    >
                      {step.status}
                    </span>
                  )}
                  {step.repeats > 0 && (
                    <span className="text-ink-faint tabular-nums" title="consecutive repeats collapsed">
                      ×{step.repeats + 1}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>

          <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed tabular-nums">
            {count(journey.requestCount)} requests
            {journey.errorRate > 0 && (
              <>
                {' · '}
                <span className="text-fail">
                  {pct(journey.errorRate)}% of them failed in production
                </span>
              </>
            )}
            {journey.medianDurationMs !== null && ` · median ${duration(journey.medianDurationMs)}`}
            {journey.containingSessionCount > journey.sessionCount &&
              ` · ${count(journey.containingSessionCount)} sessions contain it inside a longer path`}
            {` · last seen ${day(journey.lastSeen)}`}
          </p>

          <p className="text-ink-faint mt-1 text-[11.5px] leading-relaxed">
            {coverage.blurb}
            {journey.coverage.matchedTests.length > 0 && (
              <>
                {' '}
                Closest:{' '}
                {journey.coverage.matchedTests.slice(0, 3).map((test, i) => (
                  <span key={test.id}>
                    {i > 0 && ', '}
                    <Link href={`/tests/${test.id}`} className="text-accent hover:underline">
                      {test.name}
                    </Link>{' '}
                    <span className="tabular-nums">
                      ({test.matchedSteps} step{test.matchedSteps === 1 ? '' : 's'})
                    </span>
                  </span>
                ))}
                {journey.coverage.matchedTests.length > 3 &&
                  ` and ${journey.coverage.matchedTests.length - 3} more`}
                .
              </>
            )}
          </p>

          <p className="text-ink-faint mt-1 font-mono text-[10.5px]">
            {journey.suggestedTestType} · {journey.suggestedPriority.toLowerCase().replace(/_/g, ' ')}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── What the proposal did ───────────────────────────────────────────────────

function ProposalResult({
  proposal,
  projectId,
}: {
  proposal: TrafficProposal;
  projectId: string;
}) {
  /*
   * Green means a thing happened. Generation without a model does not happen,
   * so a plan that could not be queued is reported in the neutral tone and says
   * why — it must never read as "queued" and then die in the worker where
   * nobody is looking.
   */
  const queued = proposal.generation?.queued !== false;
  const good = proposal.accepted > 0 && queued;

  return (
    <div
      className={cn(
        'mt-3 rounded-lg border px-3.5 py-3',
        good
          ? 'border-[color-mix(in_srgb,var(--color-pass)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-pass)_7%,transparent)]'
          : 'border-line bg-surface-1',
      )}
    >
      {proposal.accepted > 0 ? (
        <>
          <p className={cn('text-[12.5px] font-medium tabular-nums', queued && 'text-pass')}>
            {queued
              ? `${proposal.accepted} test${proposal.accepted === 1 ? '' : 's'} queued for generation.`
              : `${proposal.accepted} plan item${proposal.accepted === 1 ? '' : 's'} written. Nothing was queued.`}
          </p>
          {!queued && proposal.generation?.reason && (
            <p className="text-ink-dim mt-1.5 text-[11.5px] leading-relaxed">
              {proposal.generation.reason}
            </p>
          )}
          {proposal.items && proposal.items.length > 0 && (
            <ul className="text-ink-dim mt-1.5 space-y-0.5 text-[11.5px]">
              {proposal.items.map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ul>
          )}
          {proposal.testPlanId && (
            <Link
              href={`/projects/${projectId}/plan`}
              className="text-accent mt-2 inline-block text-[11.5px] font-medium hover:underline"
            >
              Follow the plan →
            </Link>
          )}
        </>
      ) : (
        <p className="text-ink-dim text-[12.5px]">{proposal.message ?? 'Nothing was proposed.'}</p>
      )}

      {proposal.skipped.length > 0 && (
        <div className="mt-2.5">
          <p className="text-ink-faint font-mono text-[10.5px]">skipped</p>
          <ul className="mt-1 space-y-1">
            {proposal.skipped.map((item) => (
              <li key={item.what}>
                <code className="text-ink-dim font-mono text-[11px]">{item.what}</code>
                <p className="text-ink-faint text-[11px] leading-relaxed">{item.why}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── What came out of the file ───────────────────────────────────────────────

function Ingest({ analysis }: { analysis: TrafficAnalysis }) {
  const { totals, window: seen } = analysis;
  const identity = Object.entries(analysis.identityBreakdown).sort((a, b) => b[1] - a[1]);

  return (
    <section className="border-line mt-8 border-t pt-4">
      <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
        The upload · {FORMAT_LABEL[analysis.format] ?? analysis.format}
        {seen && (
          <span className="font-normal normal-case">
            {' '}
            · {day(seen.from)} → {day(seen.to)}
          </span>
        )}
      </h3>

      <div className="mt-2.5 grid grid-cols-2 gap-x-[18px] gap-y-1.5 font-mono text-[10.5px] sm:grid-cols-4">
        <span className="text-ink-dim">
          sessions <span className="text-ink tabular-nums">{count(totals.sessions)}</span>
        </span>
        <span className="text-ink-dim">
          requests <span className="text-ink tabular-nums">{count(totals.requests)}</span>
        </span>
        <span className="text-ink-dim">
          static excluded{' '}
          <span className="text-ink tabular-nums">{count(totals.staticAssetsFiltered)}</span>
        </span>
        <span className="text-ink-dim">
          bots excluded{' '}
          <span className="text-ink tabular-nums">{count(totals.botRequestsFiltered)}</span>
        </span>
      </div>

      {identity.length > 0 && (
        <p className="text-ink-faint mt-2.5 text-[11.5px] leading-relaxed">
          Sessions were grouped by{' '}
          {identity
            .map(([kind, n]) => `${kind.toLowerCase().replace(/_/g, ' ')} (${count(n)})`)
            .join(', ')}
          .
        </p>
      )}

      {totals.skipped > 0 && (
        <div className="mt-2.5">
          <p className="text-ink-dim text-[12px] tabular-nums">
            {count(totals.skipped)} entr{totals.skipped === 1 ? 'y' : 'ies'} could not be read
          </p>
          <ul className="text-ink-faint mt-1 space-y-0.5 text-[11px]">
            {Object.entries(totals.skippedReasons).map(([reason, n]) => (
              <li key={reason} className="tabular-nums">
                {count(n)} — {reason}
              </li>
            ))}
          </ul>
          {totals.unparsedLineNumbers.length > 0 && (
            <p className="text-ink-faint mt-1 text-[11px] leading-relaxed tabular-nums">
              Line{totals.unparsedLineNumbers.length === 1 ? '' : 's'}{' '}
              {totals.unparsedLineNumbers.slice(0, 20).join(', ')}
              {totals.unparsedLineNumbers.length > 20 ? '…' : ''}. Line numbers only — the content of
              an unreadable line is exactly what should not be echoed back.
            </p>
          )}
        </div>
      )}

      {analysis.parameterisation.length > 0 && (
        <div className="mt-2.5">
          <p className="text-ink-faint font-mono text-[10.5px]">positions collapsed into a parameter</p>
          <ul className="mt-1 space-y-1">
            {analysis.parameterisation.map((note) => (
              <li key={note.template}>
                <code className="text-accent font-mono text-[11px]">{note.template}</code>
                <p className="text-ink-faint text-[11px] leading-relaxed">{note.reason}</p>
              </li>
            ))}
          </ul>
          <p className="text-ink-faint mt-1.5 text-[11px] leading-relaxed">
            Shown so the guess is arguable: if one of these is a real page rather than an id, the
            journeys above merged two things that are not the same.
          </p>
        </div>
      )}

      {analysis.warnings.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {analysis.warnings.map((warning) => (
            <li key={warning} className="text-flake text-[11px] leading-relaxed">
              {warning}
            </li>
          ))}
        </ul>
      )}

      {totals.truncated && (
        <p className="text-flake mt-2.5 text-[11px] leading-relaxed">
          The upload was larger than one analysis window, so only its first entries were read. The
          percentages describe that slice, not the whole file.
        </p>
      )}
    </section>
  );
}
