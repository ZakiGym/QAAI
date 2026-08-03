'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  ApiError,
  type ReproDuplicate,
  type ReproExtracted,
  type ReproFlowMatch,
  type ReproResponse,
  type ReproVerdict,
} from '../../lib/api';
import { duration } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { ReproForm, type ReproRequest } from '../../components/ReproForm';
import { TestsHeader } from '../../components/TestsHeader';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { Page, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * Test-from-bug-report (§10).
 *
 * The right column is the endpoint's pipeline in order, and the order is the
 * argument:
 *
 *   1 what was understood → 2 what it matched → 3 is it already covered →
 *   4 THE RUN RESULT
 *
 * Step 1 exists because an agent that quietly misreads a ticket and writes the
 * wrong test is worse than one that asks. Everything in it is deterministic —
 * no model touched it — which is why the heading says so, and why it is worth
 * showing even on a deployment where generation cannot run at all.
 *
 * Step 4 is the one the feature lives or dies by. A reproduction that PASSES
 * has reproduced nothing, and that case is rendered as loudly as a failure,
 * never as a success. The API also leaves such a test disabled; the screen says
 * so in the same breath, because "we wrote you a test" and "that test proves
 * your bug exists" are different claims and only one of them is true here.
 */

const HOW_LABEL: Record<string, string> = {
  EXACT: 'exact',
  PARAMETERISED: 'parameterised',
  NORMALISED: 'normalised',
  FUZZY: 'closest guess',
  NONE: 'no match',
};

const SECTION_LABEL: Record<string, string> = {
  TITLE: 'title',
  STEPS: 'steps',
  EXPECTED: 'expected',
  ACTUAL: 'actual',
  ENVIRONMENT: 'environment',
  ERRORS: 'errors',
  DESCRIPTION: 'description',
  OTHER: 'other',
};

/** The shape the steps arrived in — worth naming, because it is what was parsed. */
const STEPS_FORMAT: Record<string, string> = {
  ORDERED: 'ordered',
  STEP_N: 'step n',
  GHERKIN: 'gherkin',
  BULLET: 'bullets',
  INLINE: 'inline prose',
  LINES: 'one per line',
  NONE: 'none found',
};

/** The four sections a report needs to be transcribed rather than inferred. */
const WANTED = ['STEPS', 'EXPECTED', 'ACTUAL', 'ENVIRONMENT'] as const;

function Step({
  n,
  label,
  aside,
  children,
}: {
  n: number;
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={n === 1 ? undefined : 'mt-[18px]'}>
      <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
        {n} · {label}
        {aside && <span className="text-ink-dim font-normal normal-case"> — {aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Chip({
  tone = 'faint',
  children,
}: {
  tone?: 'pass' | 'flake' | 'faint';
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'border-line rounded-sm border px-2 py-[3px] font-mono text-[10.5px]',
        tone === 'pass' && 'text-pass',
        tone === 'flake' && 'text-flake',
        tone === 'faint' && 'text-ink-faint',
      )}
    >
      {children}
    </span>
  );
}

export default function ReproPage() {
  const router = useRouter();
  const { project, projects, loading: projectsLoading } = useProject();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<ReproResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Kept so "write one anyway" can resend the same report with force. */
  const [lastRequest, setLastRequest] = useState<ReproRequest | null>(null);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const submit = useCallback(
    async (request: ReproRequest) => {
      if (!project) return;
      setBusy(true);
      setError(null);
      setResult(null);
      setLastRequest(request);
      try {
        const response = await api<ReproResponse>(`/repro/${project.id}`, {
          method: 'POST',
          body: JSON.stringify(request),
        });
        setResult(response);
        if (response.reproduction?.outcome === 'NOT_REPRODUCED') {
          toast.error(response.reproduction.headline);
        } else if (response.reproduction?.outcome === 'REPRODUCED') {
          toast.success('The reproduction failed against the app — the bug is captured.');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        const message = err instanceof Error ? err.message : 'That report could not be read.';
        setError(message);
        toast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [project, router, toast],
  );

  if (projectsLoading) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[980px] px-10 pt-8">
          <Skeleton className="h-56 w-full" />
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
            title="A test written from a bug report, then run"
            body={
              projects.length === 0
                ? 'Paste a ticket or drop in an issue URL and QAAI extracts the steps, writes a test against the crawl, runs it, and tells you whether it actually reproduced anything. It needs an app to run against first.'
                : 'Choose an app in the sidebar — the report is matched against that app’s crawl and its existing tests.'
            }
            {...(projects.length === 0
              ? { action: { label: 'Add an app', href: '/onboarding' } }
              : {})}
          />
        </div>
      </Page>
    );
  }

  const ran = result?.run?.result;

  return (
    <Page width="full">
      <TestsHeader />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[980px] grid-cols-1 gap-8 px-10 pt-8 pb-16 lg:grid-cols-[minmax(260px,380px)_minmax(300px,1fr)]">
          <div>
            <ReproForm
              project={project}
              busy={busy}
              note={
                ran ? (
                  <span className="text-ink-faint font-mono text-[10.5px] tabular-nums">
                    ran in {duration(ran.durationMs)}
                  </span>
                ) : busy ? (
                  <span className="text-ink-faint font-mono text-[10.5px] tabular-nums">
                    {elapsed}s · a run is held for up to 90
                  </span>
                ) : null
              }
              onSubmit={(request) => void submit(request)}
            />
          </div>

          <div>
            {busy && (
              <div className="space-y-3" role="status" aria-label="Reading the report">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-28 w-full" />
                <p className="text-ink-faint text-[11px] leading-relaxed">
                  Extracting, matching the crawl, checking for a test that already covers this —
                  then generating and running. Nothing above the run needed a model.
                </p>
              </div>
            )}

            {error && !busy && (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-fail)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-4">
                <p className="text-fail text-[13px] leading-relaxed">{error}</p>
              </div>
            )}

            {!busy && !error && !result && (
              <p className="text-ink-faint text-[12.5px] leading-relaxed">
                The pipeline appears here: what was understood, what it matched in the crawl,
                whether your suite already covers it, and — last, because it is the only claim that
                counts — whether the test actually failed.
              </p>
            )}

            {result && !busy && (
              <>
                <Understood extracted={result.extracted} source={result.source} />
                <FlowMatch match={result.flowMatch} />
                <AlreadyCovered
                  duplicate={result.duplicate}
                  candidates={result.duplicateCandidates}
                  busy={busy}
                  onForce={() => lastRequest && void submit({ ...lastRequest, force: true })}
                />
                {/* Keyed on the test: RunResult holds "have I enabled it yet",
                    and a second report must not inherit the first one's answer. */}
                <RunResult
                  key={result.test?.id ?? 'no-test'}
                  result={result}
                  projectId={project.id}
                />
                <TheTest result={result} />
              </>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}

// ─── 1 · UNDERSTOOD ──────────────────────────────────────────────────────────

function Understood({
  extracted,
  source,
}: {
  extracted: ReproExtracted;
  source: ReproResponse['source'];
}) {
  const missing = WANTED.filter((section) => !extracted.found.includes(section));
  const thin = extracted.structureScore < 0.45;
  const env = extracted.environment;
  const envParts = [env.browser, env.os, env.device, env.appVersion, env.envName].filter(
    (part): part is string => Boolean(part),
  );

  return (
    <Step n={1} label="Understood" aside="deterministic, no model">
      <div className="mt-2 flex flex-wrap gap-1.5">
        {extracted.found.includes('STEPS') && (
          <Chip tone="pass">
            steps ✓ {STEPS_FORMAT[extracted.stepsFormat] ?? 'read'} ×{extracted.steps.length}
          </Chip>
        )}
        {extracted.found
          .filter((section) => section !== 'STEPS')
          .map((section) => (
            <Chip key={section} tone="pass">
              {SECTION_LABEL[section] ?? section.toLowerCase()} ✓
            </Chip>
          ))}
        {missing.map((section) => (
          <Chip key={section}>{SECTION_LABEL[section]} — missing</Chip>
        ))}
        <Chip>structure {Math.round(extracted.structureScore * 100)}%</Chip>
      </div>

      {source.kind === 'ISSUE' && (
        <p className="text-flake mt-2 text-[11.5px] leading-relaxed">
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            {source.provider} {source.key}
          </a>{' '}
          — third-party text QAAI did not author. Read the steps before running this against
          anything that matters.
        </p>
      )}

      <p className="mt-2.5 text-[13px] font-medium">
        {extracted.title ?? 'The report had no title line.'}
      </p>

      {extracted.steps.length > 0 ? (
        <ol className="mt-1.5 space-y-0.5">
          {extracted.steps.map((step, i) => (
            <li key={`${i}-${step}`} className="text-ink-dim flex gap-2 text-[12.5px]">
              <span className="text-ink-faint font-mono text-[11px] tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1">{step}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-flake mt-1.5 text-[12.5px] leading-relaxed">
          No steps were found, so the test below is inference rather than transcription.
        </p>
      )}

      <div className="border-line mt-3 border-t pt-2.5 text-[12.5px] leading-relaxed">
        <p className="text-ink-dim">
          <span className="text-ink-faint font-mono text-[10.5px]">expected</span>{' '}
          {extracted.expected ??
            'not stated — it has to be derived from the actual by negation, which is a weaker test'}
        </p>
        <p className="text-ink-dim mt-1">
          <span className="text-ink-faint font-mono text-[10.5px]">actual</span>{' '}
          {extracted.actual ?? 'not stated'}
        </p>
        {envParts.length > 0 && (
          <p className="text-ink-dim mt-1">
            <span className="text-ink-faint font-mono text-[10.5px]">environment</span>{' '}
            {envParts.join(' · ')}
          </p>
        )}
        <p className="text-ink-faint mt-1.5 text-[11px] leading-relaxed">
          A test that asserts what the reporter SAW would pass against the broken app and prove
          nothing, so the assertion is always the expected behaviour.
        </p>
      </div>

      {thin && (
        <p className="text-flake mt-2 text-[11px] leading-relaxed">
          This report gave up very little structure, so most of the test is inference rather than
          transcription. Check the steps before you trust a failure.
        </p>
      )}

      {extracted.errorStrings.length > 0 && (
        <div className="mt-2.5">
          <p className="text-ink-faint font-mono text-[10.5px]">
            errors the report named — the run&rsquo;s own failure is held against these
          </p>
          <ul className="mt-1 space-y-0.5">
            {extracted.errorStrings.map((message) => (
              <li key={message} className="text-ink-dim font-mono text-[11px] break-words">
                {message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {extracted.codeBlocks.length > 0 && (
        <div className="mt-2.5">
          <p className="text-ink-faint font-mono text-[10.5px]">pasted blocks</p>
          {extracted.codeBlocks.map((block, i) => (
            <pre
              key={i}
              className="border-line bg-surface-2 text-ink-dim mt-1 max-h-40 overflow-auto rounded-md border p-2.5 font-mono text-[11px] whitespace-pre-wrap"
            >
              {block}
            </pre>
          ))}
        </div>
      )}
    </Step>
  );
}

// ─── 2 · MATCHED THE CRAWL ───────────────────────────────────────────────────

function FlowMatch({ match }: { match: ReproFlowMatch }) {
  return (
    <Step n={2} label="Matched the crawl">
      {match.matches.length > 0 ? (
        <p className="text-ink-dim mt-2 text-[12.5px] leading-relaxed">
          {match.matches.map((route, i) => (
            <span key={route.reported}>
              {i > 0 && ' · '}
              <span className={cn('font-mono text-[11px]', route.route ? 'text-ink' : 'text-fail')}>
                {route.route ?? route.reported}
              </span>{' '}
              {HOW_LABEL[route.how] ?? route.how.toLowerCase()}
              {route.offEnvironment && <span className="text-flake"> · another origin</span>}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-ink-dim mt-2 text-[12.5px] leading-relaxed">
          No route in the report matched the crawl, so the test starts at the environment&rsquo;s
          base URL.
        </p>
      )}

      {match.startRoute && (
        <p className="text-ink-faint mt-1 text-[11.5px]">
          the reproduction opens at <span className="text-accent font-mono">{match.startRoute}</span>
          {match.feature ? ` in ${match.feature}` : ''}
        </p>
      )}

      {match.warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {match.warnings.map((warning) => (
            <li key={warning} className="text-flake text-[11px] leading-relaxed">
              {warning}
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

// ─── 3 · ALREADY COVERED? ────────────────────────────────────────────────────

function AlreadyCovered({
  duplicate,
  candidates,
  busy,
  onForce,
}: {
  duplicate: ReproDuplicate | null;
  candidates: ReproDuplicate[];
  busy: boolean;
  onForce: () => void;
}) {
  const closest = duplicate ?? candidates[0] ?? null;

  return (
    <Step n={3} label="Already covered?">
      {!closest ? (
        <p className="text-ink-dim mt-2 text-[12.5px] leading-relaxed">
          Nothing in your suite touches the same ground.
        </p>
      ) : (
        <p className="text-ink-dim mt-2 text-[12.5px] leading-relaxed">
          Closest: <span className="text-ink">&ldquo;{closest.name}&rdquo;</span> —{' '}
          <span className="tabular-nums">{Math.round(closest.score * 100)}%</span> similar.{' '}
          <span className="text-ink-faint">
            {duplicate
              ? `${duplicate.reasons.join('; ')}. No second test was written — a duplicate needs both a score over the threshold and two independent reasons, and this cleared both.`
              : 'Not a duplicate; the check fails open, because a redundant test is cheaper than a bug nobody reproduced.'}
          </span>
        </p>
      )}

      {duplicate && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <Button size="sm" loading={busy} onClick={onForce}>
            Write one anyway
          </Button>
          <span className="text-ink-faint text-[11px]">
            Sends the same report again with the duplicate check overridden.
          </span>
        </div>
      )}

      {candidates.length > 1 && !duplicate && (
        <ul className="mt-1.5 space-y-0.5">
          {candidates.slice(1, 4).map((candidate) => (
            <li key={candidate.testId} className="text-ink-faint text-[11px]">
              <Link href={`/tests/${candidate.testId}`} className="text-accent hover:underline">
                {candidate.name}
              </Link>{' '}
              <span className="tabular-nums">{Math.round(candidate.score * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

// ─── 4 · THE RUN RESULT, which is the whole point ────────────────────────────

const VERDICT_STYLE: Record<ReproVerdict['outcome'], string> = {
  REPRODUCED:
    'border-[color-mix(in_srgb,var(--color-pass)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-pass)_7%,transparent)]',
  // Loud. A green reproduction is the failure mode this whole screen exists to
  // stop someone misreading as a success.
  NOT_REPRODUCED:
    'border-[color-mix(in_srgb,var(--color-fail)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)]',
  INCONCLUSIVE:
    'border-[color-mix(in_srgb,var(--color-flake)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)]',
};

function RunResult({ result, projectId }: { result: ReproResponse; projectId: string }) {
  const { reproduction, run, test } = result;
  const router = useRouter();
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(test?.enabled ?? false);
  const [enableError, setEnableError] = useState<string | null>(null);

  /** The soft-delete restore endpoint IS "enable" — a disabled test is one with `disabledAt` set. */
  async function enable() {
    if (!test || enabling) return;
    setEnabling(true);
    setEnableError(null);
    try {
      await api(`/projects/${projectId}/tests/${test.id}/restore`, { method: 'POST' });
      setEnabled(true);
    } catch (err) {
      setEnableError(err instanceof Error ? err.message : 'Could not enable that test');
    } finally {
      setEnabling(false);
    }
  }

  if (!reproduction) {
    return (
      <Step n={4} label="The run result">
        <div className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--color-flake)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)] px-3.5 py-3">
          <p className="text-[13.5px] font-semibold">Nothing has been reproduced.</p>
          <p className="text-ink-dim mt-1.5 text-[12px] leading-relaxed">
            No test was written, so none was run. A bug report is only reproduced once a test built
            from it has been watched to fail against the app.
          </p>
        </div>
      </Step>
    );
  }

  return (
    <Step n={4} label="The run result">
      <div className={cn('mt-2 rounded-lg border px-3.5 py-3', VERDICT_STYLE[reproduction.outcome])}>
        <p className="text-[13.5px] leading-snug font-semibold">{reproduction.headline}</p>
        <p className="text-ink-dim mt-1.5 text-[12px] leading-relaxed">
          {reproduction.detail}
          {test && !enabled && (
            <>
              {' '}
              It stays <span className="text-flake">disabled</span> until you enable it — a repro
              that PASSES has reproduced nothing, and would gate on nothing.
            </>
          )}
          {test && enabled && (
            <>
              {' '}
              It is <span className="text-pass">enabled</span> and part of the suite — it was
              allowed in because it was seen to fail.
            </>
          )}
        </p>

        {reproduction.matchedReportedError && (
          <p className="text-ink-dim mt-2 font-mono text-[11px] break-words">
            matched: {reproduction.matchedReportedError}
          </p>
        )}

        {run?.result?.errorMessage && (
          <pre className="border-line bg-surface-2 text-ink-dim mt-2 max-h-40 overflow-auto rounded-md border p-2.5 font-mono text-[11px] whitespace-pre-wrap">
            {run.result.errorMessage}
          </pre>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {test && !enabled && (
            <Button variant="primary" size="sm" loading={enabling} onClick={() => void enable()}>
              Save &amp; enable
            </Button>
          )}
          {test && (
            <Button size="sm" onClick={() => router.push(`/editor?test=${test.id}`)}>
              Open in editor
            </Button>
          )}
          {run && (
            <Link href={`/runs/${run.id}`} className="text-accent text-[11.5px] hover:underline">
              open the run →
            </Link>
          )}
          {run && !run.finished && (
            <span className="text-flake text-[11px] tabular-nums">
              Still running after {Math.round(run.waitedMs / 1000)}s — until it finishes, nothing is
              known either way.
            </span>
          )}
        </div>

        {enableError && <p className="text-fail mt-2 text-[11px]">{enableError}</p>}
      </div>
    </Step>
  );
}

// ─── The test it wrote ───────────────────────────────────────────────────────

function TheTest({ result }: { result: ReproResponse }) {
  const { planItem, test, generation, notes } = result;

  return (
    <section className="border-line mt-6 border-t pt-4">
      <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
        The test it wrote
      </h3>

      <p className="mt-2 text-[13px] font-medium">{planItem.title}</p>
      <p className="text-ink-dim mt-1 text-[12px] leading-relaxed">{planItem.rationale}</p>

      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-ink-faint font-mono text-[10.5px]">steps it will drive</p>
          <ol className="mt-1 space-y-0.5">
            {planItem.steps.map((step, i) => (
              <li key={`${i}-${step}`} className="text-ink-dim flex gap-2 text-[12px]">
                <span className="text-ink-faint font-mono text-[10.5px] tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">{step}</span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <p className="text-ink-faint font-mono text-[10.5px]">what it asserts</p>
          <ul className="mt-1 space-y-1">
            {planItem.assertions.map((assertion) => (
              <li key={assertion} className="text-ink-dim text-[12px] leading-relaxed">
                {assertion}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* A missing model is information, not a failure: everything above this
          line was derived from the report and the crawl without one. */}
      {generation?.skipped && (
        <div className="border-line bg-surface-2 mt-3 rounded-md border p-3">
          <p className="text-[12.5px] font-medium">No code was written</p>
          <p className="text-ink-dim mt-1 text-[12px] leading-relaxed">
            {generation.reason === 'ANTHROPIC_API_KEY is not set' ? (
              <>
                This deployment has no model configured (
                <code className="font-mono">ANTHROPIC_API_KEY</code> is unset), so the plan above is
                as far as it goes. Everything in it — the steps, the assertions, the start route, the
                duplicate check — was derived from your report and your crawl, not generated, and
                stays true once a key is set.
              </>
            ) : (
              <>{generation.reason}. The plan above is deterministic and stands on its own.</>
            )}
          </p>
        </div>
      )}

      {test && (
        <div className="mt-3">
          <p className="text-ink-faint font-mono text-[10.5px]">{test.filePath}</p>
          {test.reviewFlags.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {test.reviewFlags.map((flag) => (
                <li key={flag} className="text-flake text-[11px] leading-relaxed">
                  {flag}
                </li>
              ))}
            </ul>
          )}
          <pre className="border-line bg-surface-2 text-ink-dim mt-2 max-h-72 overflow-auto rounded-md border p-3 font-mono text-[11px]">
            {test.code}
          </pre>
        </div>
      )}

      {notes.length > 0 && (
        <div className="mt-3">
          <p className="text-ink-faint font-mono text-[10.5px]">read before trusting this</p>
          <ul className="mt-1 space-y-1">
            {notes.map((note) => (
              <li key={note} className="text-ink-dim text-[12px] leading-relaxed">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
