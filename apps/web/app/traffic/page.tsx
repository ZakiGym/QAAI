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
import { duration } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { TrafficUpload } from '../../components/TrafficUpload';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { Badge, Card, Page, PageHeader, SectionLabel, Skeleton } from '../../components/ui/layout';

/**
 * Tests from production traffic (§8).
 *
 * The argument the whole screen makes is one number: the share of real sessions
 * that walk a journey. A suite written from a spec tests what someone imagined
 * users do; a suite written from this tests what they did. So the percentage is
 * the largest thing in every row, and the ranking is never re-sorted client-side
 * — the API already ranked it and the order IS the recommendation.
 *
 * THE REDACTION SUMMARY COMES FIRST, before the journeys, before the totals.
 * A customer is uploading production traffic to a vendor. Until they know
 * exactly what was stripped, and that it was stripped on the way in rather than
 * hidden on the way out, nothing further down the page has earned a reading.
 * Every category is listed including the ones that came back zero: "we looked
 * for card numbers and found none" is a different statement from silence.
 */

const REDACTION_ORDER: RedactionKind[] = [
  'REQUEST_BODY',
  'RESPONSE_BODY',
  'HEADER',
  'COOKIE',
  'QUERY_VALUE',
  'URL_CREDENTIALS',
  'IP_ADDRESS',
  'USER_AGENT',
  'USER_IDENTIFIER',
  'EMAIL',
  'PHONE',
  'CARD_NUMBER',
  'NATIONAL_ID',
  'JWT',
  'OPAQUE_TOKEN',
  'PATH_IDENTIFIER',
];

const REDACTION_LABEL: Record<RedactionKind, string> = {
  REQUEST_BODY: 'Request bodies',
  RESPONSE_BODY: 'Response bodies',
  HEADER: 'Header values',
  COOKIE: 'Cookie values',
  QUERY_VALUE: 'Query-string values',
  URL_CREDENTIALS: 'Credentials in URLs',
  IP_ADDRESS: 'Client IP addresses',
  USER_AGENT: 'User-Agent strings',
  USER_IDENTIFIER: 'User identifiers',
  EMAIL: 'Email addresses',
  PHONE: 'Phone numbers',
  CARD_NUMBER: 'Card numbers',
  NATIONAL_ID: 'National ids',
  JWT: 'JWTs',
  OPAQUE_TOKEN: 'Opaque tokens',
  PATH_IDENTIFIER: 'Identifiers in paths',
};

const FORMAT_LABEL: Record<string, string> = {
  HAR: 'HAR',
  ACCESS_LOG: 'Access log',
  OTLP: 'OTLP spans',
};

const COVERAGE: Record<
  TrafficJourney['coverage']['status'],
  { label: string; tone: 'pass' | 'flake' | 'accent'; blurb: string }
> = {
  COVERED: {
    label: 'Already covered',
    tone: 'pass',
    blurb: 'A test in your suite already walks this. Proposing it again duplicates work.',
  },
  PARTIAL: {
    label: 'Partly covered',
    tone: 'flake',
    blurb: 'Some steps are tested and some are not — the gap is listed below.',
  },
  UNCOVERED: {
    label: 'Not covered',
    tone: 'accent',
    blurb: 'Nothing in your suite mentions these routes.',
  },
};

function pct(share: number): string {
  const value = share * 100;
  return value >= 9.5 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
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
  const [analysing, setAnalysing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeCovered, setIncludeCovered] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<TrafficProposal | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);

  const uncovered = useMemo(
    () => (analysis?.journeys ?? []).filter((j) => j.coverage.status !== 'COVERED'),
    [analysis],
  );
  const selectedJourneys = useMemo(
    () => (analysis?.journeys ?? []).filter((j) => selected.has(j.id)),
    [analysis, selected],
  );
  const selectedCovered = selectedJourneys.filter((j) => j.coverage.status === 'COVERED').length;

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

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function propose() {
    if (!project || selectedJourneys.length === 0 || !analysis) return;
    setProposing(true);
    setProposeError(null);
    setProposal(null);
    try {
      const result = await api<TrafficProposal>(`/traffic/${project.id}/propose`, {
        method: 'POST',
        body: JSON.stringify({
          // Sent back exactly as they arrived. The API recomputes each journey's
          // id from its steps and refuses the request if they disagree, so
          // trimming or "tidying" a journey here would fail the whole batch.
          journeys: selectedJourneys,
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
        setSelected(new Set());
      }
    } catch (err) {
      const message = describe(err, 'The proposal was refused.');
      if (message) {
        setProposeError(message);
        toast.error(message);
      }
    } finally {
      setProposing(false);
    }
  }

  if (projectsLoading) {
    return (
      <Page width="wide">
        <PageHeader title="Traffic" />
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }

  if (!project) {
    return (
      <Page width="wide">
        <PageHeader title="Traffic" />
        <EmptyState
          title="Journeys from your production traffic"
          body={
            projects.length === 0
              ? 'Upload a HAR, an access log or an OTLP export and QAAI ranks the journeys your users actually walk, then writes tests for the ones your suite misses. It needs an app to analyse first.'
              : 'Choose an app in the switcher above — the analysis is cross-referenced against that app’s suite.'
          }
          {...(projects.length === 0
            ? { action: { label: 'Add an app', href: '/onboarding' } }
            : {})}
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Traffic"
        subtitle={`Upload a HAR, an access log or an OTLP export from ${project.name} — QAAI ranks the journeys your users actually walk, checks them against your suite, and writes tests for what is missing.`}
      />

      <TrafficUpload
        projectId={project.id}
        busy={analysing}
        onStart={() => {
          setAnalysing(true);
          setAnalysis(null);
          setSelected(new Set());
          setProposal(null);
          setProposeError(null);
        }}
        onAnalysed={(next) => {
          setAnalysing(false);
          setAnalysis(next);
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

      {/* Never the empty state while a request is in flight. */}
      {analysing && (
        <div className="mt-10 space-y-3" role="status" aria-label="Analysing the upload">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-24 w-full" />
          <p className="text-ink-faint text-micro text-center">
            Redacting on ingest, sessionising, then ranking. No model is involved — this is
            arithmetic over your upload.
          </p>
        </div>
      )}

      {analysis && !analysing && (
        <div className="mt-10 space-y-10">
          <Redaction analysis={analysis} />
          <Ingest analysis={analysis} />

          <section>
            <div className="mb-3 flex items-end justify-between gap-4">
              <SectionLabel>
                What your users actually do · {analysis.journeys.length} journeys
              </SectionLabel>
              {uncovered.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(new Set(uncovered.map((j) => j.id)))}
                  className="text-accent text-micro mb-3 font-medium hover:underline"
                >
                  Select the {uncovered.length} your suite misses
                </button>
              )}
            </div>

            {analysis.journeys.length === 0 ? (
              <EmptyState
                title="No journey appeared more than once"
                body="Every session in this upload walked a different path, so there is no repeated journey to rank. That usually means the window is too short, or the traffic is bots rather than people — try a longer capture."
              />
            ) : (
              <div className="space-y-2">
                {analysis.journeys.map((journey, index) => (
                  <JourneyRow
                    key={journey.id}
                    journey={journey}
                    rank={index + 1}
                    totalSessions={analysis.totals.sessions}
                    checked={selected.has(journey.id)}
                    onToggle={() => toggle(journey.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {analysis.journeys.length > 0 && (
            <ProposeBar
              projectId={project.id}
              selectedCount={selectedJourneys.length}
              selectedCovered={selectedCovered}
              includeCovered={includeCovered}
              onIncludeCovered={setIncludeCovered}
              busy={proposing}
              onPropose={() => void propose()}
              proposal={proposal}
              error={proposeError}
            />
          )}
        </div>
      )}
    </Page>
  );
}

// ─── Redaction: the first thing on the page ──────────────────────────────────

function Redaction({ analysis }: { analysis: TrafficAnalysis }) {
  const { redaction } = analysis;
  const total = REDACTION_ORDER.reduce((sum, kind) => sum + (redaction.counts[kind] ?? 0), 0);

  return (
    <section>
      <SectionLabel>What was stripped before anything was stored</SectionLabel>
      <Card className="border-accent/40 p-5">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {count(total)} value{total === 1 ? '' : 's'} removed
        </p>
        <p className="text-ink-dim text-body-sm mt-1">{redaction.when}.</p>

        <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
          {REDACTION_ORDER.map((kind) => {
            const n = redaction.counts[kind] ?? 0;
            return (
              <div key={kind} className={n > 0 ? '' : 'opacity-45'}>
                <p className="text-lg font-medium tabular-nums">{count(n)}</p>
                <p className="text-ink-dim text-micro">{REDACTION_LABEL[kind]}</p>
              </div>
            );
          })}
        </div>
        <p className="text-ink-faint text-micro mt-3">
          A zero is an answer, not a gap: the category was looked for and this upload had none of
          it.
        </p>

        <div className="border-line mt-5 border-t pt-4">
          <p className="text-ink text-body-sm font-medium">Never read at all</p>
          {/* A sentence rather than chips: these strings run from two words to a
              full parenthetical, and a row of badges that wide reads as noise. */}
          <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">
            {redaction.neverRead.join(', ')}.
          </p>
          <p className="text-ink-faint text-micro mt-1.5 leading-relaxed">
            A stronger guarantee than masking: these were not opened, so there is nothing to have
            leaked.
          </p>
        </div>

        {redaction.queryParamNamesKept.length > 0 && (
          <div className="border-line mt-4 border-t pt-4">
            <p className="text-ink text-body-sm font-medium">
              Query parameter names kept — their values were not
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {redaction.queryParamNamesKept.map((name) => (
                <li key={name}>
                  <Badge mono>{name}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-line mt-4 space-y-2 border-t pt-4">
          <p className="text-ink-dim text-micro leading-relaxed">{redaction.identityHashing}</p>
          <p className="text-ink-dim text-micro leading-relaxed">{redaction.note}</p>
        </div>
      </Card>
    </section>
  );
}

// ─── What came out of the file ───────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-lg font-medium tabular-nums">{value}</p>
      <p className="text-ink-dim text-micro">{label}</p>
      {hint && <p className="text-ink-faint text-micro mt-0.5">{hint}</p>}
    </div>
  );
}

function Ingest({ analysis }: { analysis: TrafficAnalysis }) {
  const { totals, window: seen } = analysis;
  const identity = Object.entries(analysis.identityBreakdown).sort((a, b) => b[1] - a[1]);

  return (
    <section>
      <SectionLabel>What came out of the file</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{FORMAT_LABEL[analysis.format] ?? analysis.format}</Badge>
          {seen && (
            <span className="text-ink-dim text-micro tabular-nums">
              {day(seen.from)} → {day(seen.to)}
            </span>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="sessions" value={count(totals.sessions)} />
          <Stat label="requests analysed" value={count(totals.requests)} />
          <Stat label="static assets excluded" value={count(totals.staticAssetsFiltered)} />
          <Stat label="bot requests excluded" value={count(totals.botRequestsFiltered)} />
        </div>

        {identity.length > 0 && (
          <p className="text-ink-dim text-micro mt-4">
            Sessions were grouped by{' '}
            {identity
              .map(([source, n]) => `${source.toLowerCase().replace(/_/g, ' ')} (${count(n)})`)
              .join(', ')}
            .
          </p>
        )}

        {totals.skipped > 0 && (
          <div className="border-line mt-4 border-t pt-4">
            <p className="text-ink text-body-sm font-medium tabular-nums">
              {count(totals.skipped)} entr{totals.skipped === 1 ? 'y' : 'ies'} could not be read
            </p>
            <ul className="text-ink-dim text-micro mt-1.5 space-y-0.5">
              {Object.entries(totals.skippedReasons).map(([reason, n]) => (
                <li key={reason} className="tabular-nums">
                  {count(n)} — {reason}
                </li>
              ))}
            </ul>
            {totals.unparsedLineNumbers.length > 0 && (
              <p className="text-ink-faint text-micro mt-1.5 tabular-nums">
                Line{totals.unparsedLineNumbers.length === 1 ? '' : 's'}{' '}
                {totals.unparsedLineNumbers.slice(0, 20).join(', ')}
                {totals.unparsedLineNumbers.length > 20 ? '…' : ''}. Line numbers only — the content
                of an unreadable line is exactly what should not be echoed back.
              </p>
            )}
          </div>
        )}

        {analysis.parameterisation.length > 0 && (
          <div className="border-line mt-4 border-t pt-4">
            <p className="text-ink text-body-sm font-medium">
              Positions collapsed into a parameter
            </p>
            <ul className="mt-2 space-y-2">
              {analysis.parameterisation.map((note) => (
                <li key={note.template}>
                  <code className="text-accent font-mono text-micro">{note.template}</code>
                  <p className="text-ink-dim text-micro mt-0.5">{note.reason}</p>
                </li>
              ))}
            </ul>
            <p className="text-ink-faint text-micro mt-2">
              Shown so the guess is arguable: if one of these is a real page rather than an id, the
              journeys above merged two things that are not the same.
            </p>
          </div>
        )}

        {analysis.warnings.length > 0 && (
          <ul className="border-line mt-4 space-y-1.5 border-t pt-4">
            {analysis.warnings.map((warning) => (
              <li key={warning} className="text-flake text-micro leading-relaxed">
                {warning}
              </li>
            ))}
          </ul>
        )}

        {totals.truncated && (
          <p className="text-flake text-micro mt-3">
            The upload was larger than one analysis window, so only its first entries were read. The
            percentages describe that slice, not the whole file.
          </p>
        )}
      </Card>
    </section>
  );
}

// ─── One journey ─────────────────────────────────────────────────────────────

function JourneyRow({
  journey,
  rank,
  totalSessions,
  checked,
  onToggle,
}: {
  journey: TrafficJourney;
  rank: number;
  totalSessions: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const coverage = COVERAGE[journey.coverage.status];
  const inputId = `journey-${journey.id}`;

  return (
    <Card className={`p-4 ${checked ? 'border-accent/60' : ''}`}>
      <div className="flex gap-4">
        {/* `self-start` matters: a bare checkbox in a stretch flex row is grown
            to the row's height by the browser and its glyph drawn in the middle,
            which reads as belonging to nothing. */}
        <input
          id={inputId}
          type="checkbox"
          className="accent-accent mt-1.5 h-3.5 w-3.5 self-start"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${journey.name}`}
        />

        {/* The headline: the share of real sessions that walked this. */}
        <div className="w-20 shrink-0 text-right">
          <p className="text-2xl leading-none font-semibold tracking-tight tabular-nums">
            {pct(journey.sessionShare)}
          </p>
          <p className="text-ink-faint text-micro mt-1 tabular-nums">
            {count(journey.sessionCount)} of {count(totalSessions)}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-faint text-micro tabular-nums">#{rank}</span>
            <span className="text-ink text-body-sm font-medium">{journey.feature}</span>
            <Badge tone={coverage.tone}>{coverage.label}</Badge>
            <Badge>{journey.suggestedTestType}</Badge>
            <Badge>{journey.suggestedPriority.toLowerCase().replace(/_/g, ' ')}</Badge>
          </div>

          <ol className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {journey.steps.map((step, i) => (
              <li key={`${step.method}-${step.route}-${i}`} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-ink-faint text-micro">→</span>}
                <span className="border-line bg-surface-2 text-micro inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono">
                  <span className="text-ink-faint">{step.method}</span>
                  <span className="text-ink">{step.route}</span>
                  {step.status !== null && (
                    <span
                      className={`tabular-nums ${step.status >= 400 ? 'text-fail' : 'text-ink-faint'}`}
                    >
                      {step.status}
                    </span>
                  )}
                  {step.repeats > 0 && (
                    <span
                      className="text-ink-faint tabular-nums"
                      title="consecutive repeats collapsed"
                    >
                      ×{step.repeats + 1}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>

          <p className="text-ink-dim text-micro mt-2.5 tabular-nums">
            {count(journey.requestCount)} requests
            {journey.errorRate > 0 && (
              <>
                {' · '}
                <span className="text-fail">
                  {pct(journey.errorRate)} of them failed in production
                </span>
              </>
            )}
            {journey.medianDurationMs !== null && ` · median ${duration(journey.medianDurationMs)}`}
            {journey.containingSessionCount > journey.sessionCount &&
              ` · ${count(journey.containingSessionCount)} sessions contain it inside a longer path`}
            {` · last seen ${day(journey.lastSeen)}`}
          </p>

          <div className="border-line mt-3 border-t pt-2.5">
            <p className="text-ink-dim text-micro leading-relaxed">
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
            {journey.coverage.missingSteps.length > 0 && (
              <p className="text-ink-faint text-micro mt-1 font-mono">
                Untested: {journey.coverage.missingSteps.join(', ')}
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Turning a selection into tests ──────────────────────────────────────────

function ProposeBar({
  projectId,
  selectedCount,
  selectedCovered,
  includeCovered,
  onIncludeCovered,
  busy,
  onPropose,
  proposal,
  error,
}: {
  projectId: string;
  selectedCount: number;
  selectedCovered: number;
  includeCovered: boolean;
  onIncludeCovered: (next: boolean) => void;
  busy: boolean;
  onPropose: () => void;
  proposal: TrafficProposal | null;
  error: string | null;
}) {
  return (
    <section>
      <SectionLabel>Write the tests</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-ink text-body-sm font-medium tabular-nums">
              {selectedCount === 0
                ? 'No journeys selected'
                : `${selectedCount} journey${selectedCount === 1 ? '' : 's'} selected`}
            </p>
            <p className="text-ink-dim text-micro mt-1 max-w-xl leading-relaxed">
              Selecting a journey approves it — these go straight to the Generator as an approved
              plan, ranked by how many real sessions walk them. Generation runs on the worker and
              needs a model configured (<code className="font-mono">ANTHROPIC_API_KEY</code>); the
              ranking and the redaction above needed none.
            </p>
          </div>
          <Button
            variant="primary"
            disabled={selectedCount === 0}
            loading={busy}
            onClick={onPropose}
          >
            Generate {selectedCount > 0 ? selectedCount : ''} test
            {selectedCount === 1 ? '' : 's'}
          </Button>
        </div>

        {selectedCovered > 0 && (
          <label className="text-body-sm mt-4 flex items-start gap-2.5">
            <input
              type="checkbox"
              className="accent-accent mt-0.5"
              checked={includeCovered}
              onChange={(e) => onIncludeCovered(e.target.checked)}
            />
            <span>
              <span className="text-ink">
                Propose the {selectedCovered} journey{selectedCovered === 1 ? '' : 's'} your suite
                already covers
              </span>
              <span className="text-ink-faint text-micro block">
                Without this they are skipped server-side, and the reason is listed rather than
                silently dropped.
              </span>
            </span>
          </label>
        )}

        {error && (
          <div className="border-fail/50 bg-fail/10 mt-4 rounded-md border p-3.5">
            <p className="text-fail text-body-sm leading-relaxed">{error}</p>
          </div>
        )}

        {proposal &&
          (() => {
            /*
             * Green means a thing happened. Generation without a model does not
             * happen, so a plan that could not be queued is reported in the
             * neutral tone and says why — it must never read as "queued" and
             * then die in the worker where nobody is looking.
             */
            const queued = proposal.generation?.queued !== false;
            return (
              <div
                className={`mt-4 rounded-md border p-3.5 ${
                  proposal.accepted > 0 && queued
                    ? 'border-pass/40 bg-pass/10'
                    : 'border-line bg-surface-2'
                }`}
              >
                {proposal.accepted > 0 ? (
                  <>
                    <p
                      className={`text-body-sm font-medium tabular-nums ${
                        queued ? 'text-pass' : 'text-ink'
                      }`}
                    >
                      {queued
                        ? `${proposal.accepted} test${proposal.accepted === 1 ? '' : 's'} queued for generation.`
                        : `${proposal.accepted} plan item${proposal.accepted === 1 ? '' : 's'} written. Nothing was queued.`}
                    </p>
                    {!queued && proposal.generation?.reason && (
                      <p className="text-ink-dim text-micro mt-1.5 leading-relaxed">
                        {proposal.generation.reason}
                      </p>
                    )}
                    {proposal.items && proposal.items.length > 0 && (
                      <ul className="text-ink-dim text-micro mt-2 space-y-1">
                        {proposal.items.map((item) => (
                          <li key={item.id}>{item.title}</li>
                        ))}
                      </ul>
                    )}
                    {proposal.testPlanId && (
                      <Link
                        href={`/projects/${projectId}/plan`}
                        className="text-accent text-micro mt-2.5 inline-block font-medium hover:underline"
                      >
                        Follow the plan →
                      </Link>
                    )}
                  </>
                ) : (
                  <p className="text-ink-dim text-body-sm">
                    {proposal.message ?? 'Nothing was proposed.'}
                  </p>
                )}

                {proposal.skipped.length > 0 && (
                  <div className="mt-3">
                    <p className="text-ink text-micro font-medium">Skipped</p>
                    <ul className="mt-1 space-y-1.5">
                      {proposal.skipped.map((item) => (
                        <li key={item.what}>
                          <code className="text-ink-dim font-mono text-micro">{item.what}</code>
                          <p className="text-ink-faint text-micro">{item.why}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
      </Card>
    </section>
  );
}
