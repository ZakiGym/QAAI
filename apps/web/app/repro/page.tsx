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
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import {
  Badge,
  Card,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
} from '../../components/ui/layout';

/**
 * Test-from-bug-report (§10).
 *
 * The screen is the endpoint's pipeline in order, and the order is the argument:
 *
 *   what was understood → what it matched → is it already covered →
 *   the proposed test → THE RUN RESULT
 *
 * The first section exists because an agent that quietly misreads a ticket and
 * writes the wrong test is worse than one that asks. Everything in it is
 * deterministic — no model touched it — so it is worth showing on its own even
 * when generation cannot run at all.
 *
 * The last section is the one the feature lives or dies by. A reproduction that
 * PASSES has reproduced nothing, and that case is rendered as loudly as a
 * failure, never as a success. The API also leaves such a test disabled; the
 * screen says so in the same breath, because "we wrote you a test" and "that
 * test proves your bug exists" are different claims and only one of them is
 * true here.
 */

const HOW_LABEL: Record<string, string> = {
  EXACT: 'exact match',
  PARAMETERISED: 'matched a parameterised route',
  NORMALISED: 'matched after normalising ids',
  FUZZY: 'closest guess',
  NONE: 'nothing in the crawl serves this',
};

const SECTION_LABEL: Record<string, string> = {
  TITLE: 'Title',
  STEPS: 'Steps',
  EXPECTED: 'Expected',
  ACTUAL: 'Actual',
  ENVIRONMENT: 'Environment',
  ERRORS: 'Errors',
  DESCRIPTION: 'Description',
  OTHER: 'Other',
};

const STEPS_FORMAT: Record<string, string> = {
  ORDERED: 'written as a numbered list',
  STEP_N: 'written as "Step 1, Step 2…"',
  GHERKIN: 'written as Given/When/Then',
  BULLET: 'written as bullets',
  INLINE: 'pulled out of a prose sentence',
  LINES: 'taken one per line',
  NONE: 'no steps were found at all',
};

/** The four sections a report needs to be transcribed rather than inferred. */
const WANTED = ['STEPS', 'EXPECTED', 'ACTUAL', 'ENVIRONMENT'] as const;

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
      <Page width="wide">
        <PageHeader title="Reproduce a bug" />
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }

  if (!project) {
    return (
      <Page width="wide">
        <PageHeader title="Reproduce a bug" />
        <EmptyState
          title="A test written from a bug report, then run"
          body={
            projects.length === 0
              ? 'Paste a ticket or drop in an issue URL and QAAI extracts the steps, writes a test against the crawl, runs it, and tells you whether it actually reproduced anything. It needs an app to run against first.'
              : 'Choose an app in the switcher above — the report is matched against that app’s crawl and its existing tests.'
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
        title="Reproduce a bug"
        subtitle={`Paste a ticket, or point at a Jira, Linear or GitHub issue. QAAI shows what it understood, writes a test against ${project.name}, runs it, and says plainly whether the bug reproduced.`}
      />

      <ReproForm project={project} busy={busy} onSubmit={(request) => void submit(request)} />

      {busy && (
        <div className="mt-10 space-y-3" role="status" aria-label="Reading the report">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
          <p className="text-ink-faint text-micro text-center tabular-nums">
            Extracting, matching the crawl, checking for a test that already covers this — then
            generating and running. {elapsed}s elapsed; a run is held for up to 90.
          </p>
        </div>
      )}

      {error && !busy && (
        <div className="border-fail/50 bg-fail/10 mt-8 rounded-lg border p-4">
          <p className="text-fail text-body-sm leading-relaxed">{error}</p>
        </div>
      )}

      {result && !busy && (
        <div className="mt-10 space-y-10">
          <Understood extracted={result.extracted} source={result.source} />
          <FlowMatch match={result.flowMatch} />

          {result.duplicate && (
            <Duplicate
              duplicate={result.duplicate}
              busy={busy}
              onForce={() =>
                lastRequest && void submit({ ...lastRequest, force: true })
              }
            />
          )}

          <Proposed result={result} />
          <RunResult result={result} />

          {result.notes.length > 0 && (
            <section>
              <SectionLabel>Read before trusting this</SectionLabel>
              <Card className="p-5">
                <ul className="space-y-2">
                  {result.notes.map((note) => (
                    <li key={note} className="text-ink-dim text-body-sm leading-relaxed">
                      {note}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {result.duplicateCandidates.length > 0 && !result.duplicate && (
            <section>
              <SectionLabel>Tests that touch the same ground</SectionLabel>
              <Card className="p-5">
                <p className="text-ink-dim text-body-sm mb-3 leading-relaxed">
                  None scored high enough to stop generation — the check fails open, because a
                  redundant test is cheaper than a bug nobody reproduced.
                </p>
                <ul className="space-y-2">
                  {result.duplicateCandidates.map((candidate) => (
                    <li key={candidate.testId} className="flex flex-wrap items-baseline gap-2">
                      <Link
                        href={`/tests/${candidate.testId}`}
                        className="text-accent text-body-sm hover:underline"
                      >
                        {candidate.name}
                      </Link>
                      <span className="text-ink-faint text-micro tabular-nums">
                        {Math.round(candidate.score * 100)}%
                      </span>
                      <span className="text-ink-dim text-micro">
                        {candidate.reasons.join('; ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </Page>
  );
}

// ─── 1. What was understood ──────────────────────────────────────────────────

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-ink-faint text-micro">{label}</p>
      <p className="text-ink text-body-sm">{value}</p>
    </div>
  );
}

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
    <section>
      <SectionLabel>What QAAI understood, before anything was generated</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          {source.kind === 'ISSUE' ? (
            <>
              <Badge tone="accent">
                {source.provider} {source.key}
              </Badge>
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-ink-faint text-micro hover:underline"
              >
                the original ticket
              </a>
              <span className="text-flake text-micro">
                Third-party text QAAI did not author — read the steps below before running this
                against anything that matters.
              </span>
            </>
          ) : (
            <Badge>Pasted report</Badge>
          )}
        </div>

        <h3 className="mt-3 text-lg font-semibold tracking-tight">
          {extracted.title ?? 'The report had no title line.'}
        </h3>

        <div className="mt-4">
          <p className="text-ink-faint text-micro">
            Steps — {STEPS_FORMAT[extracted.stepsFormat] ?? 'read from the report'}
          </p>
          {extracted.steps.length > 0 ? (
            <ol className="mt-1.5 space-y-1">
              {extracted.steps.map((step, i) => (
                <li key={`${i}-${step}`} className="text-ink text-body-sm flex gap-2.5">
                  <span className="text-ink-faint tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">{step}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-flake text-body-sm mt-1.5">
              No steps were found, so the test below is inference rather than transcription.
            </p>
          )}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="border-line rounded-md border p-3.5">
            <p className="text-ink-faint text-micro">Expected — this becomes the assertion</p>
            <p className="text-ink text-body-sm mt-1 leading-relaxed">
              {extracted.expected ?? 'Not stated. It has to be derived from the actual by negation, which is a weaker test.'}
            </p>
          </div>
          <div className="border-line rounded-md border p-3.5">
            <p className="text-ink-faint text-micro">Actual — context only, never asserted</p>
            <p className="text-ink text-body-sm mt-1 leading-relaxed">
              {extracted.actual ?? 'Not stated.'}
            </p>
          </div>
        </div>
        <p className="text-ink-faint text-micro mt-2 leading-relaxed">
          A test that asserts what the reporter SAW would pass against the broken app and prove
          nothing, so the assertion is always the expected behaviour.
        </p>

        <div className="border-line mt-5 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
          <KeyValue
            label="Structure"
            value={`${Math.round(extracted.structureScore * 100)}%`}
          />
          <KeyValue
            label="Environment"
            value={envParts.length > 0 ? envParts.join(' · ') : 'not stated'}
          />
          <KeyValue
            label="Routes named"
            value={
              extracted.paths.length + extracted.urls.length > 0
                ? [...extracted.paths, ...extracted.urls].join(' ')
                : 'none'
            }
          />
          <KeyValue
            label="Selectors named"
            value={extracted.selectors.length > 0 ? extracted.selectors.join(' ') : 'none'}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {extracted.found.map((section) => (
            <Badge key={section} tone="pass">
              {SECTION_LABEL[section] ?? section}
            </Badge>
          ))}
          {missing.map((section) => (
            <Badge key={section}>{SECTION_LABEL[section]} missing</Badge>
          ))}
        </div>

        {thin && (
          <p className="text-flake text-micro mt-3 leading-relaxed">
            This report gave up very little structure, so most of the test below is inference
            rather than transcription. Check the steps before you trust a failure.
          </p>
        )}

        {extracted.errorStrings.length > 0 && (
          <div className="border-line mt-4 border-t pt-4">
            <p className="text-ink text-body-sm font-medium">
              Errors the report named — the run&rsquo;s own failure is held against these
            </p>
            <ul className="mt-1.5 space-y-1">
              {extracted.errorStrings.map((message) => (
                <li key={message} className="text-ink-dim font-mono text-micro break-words">
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {extracted.codeBlocks.length > 0 && (
          <div className="border-line mt-4 border-t pt-4">
            <p className="text-ink text-body-sm font-medium">Pasted blocks</p>
            {extracted.codeBlocks.map((block, i) => (
              <pre
                key={i}
                className="border-line bg-surface-2 text-ink-dim text-micro mt-2 max-h-48 overflow-auto rounded-md border p-3 font-mono whitespace-pre-wrap"
              >
                {block}
              </pre>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

// ─── 2. What it matched in the crawl ─────────────────────────────────────────

function FlowMatch({ match }: { match: ReproFlowMatch }) {
  return (
    <section>
      <SectionLabel>Where the test starts</SectionLabel>
      <Card className="p-5">
        <p className="text-ink text-body-sm">
          {match.startRoute ? (
            <>
              The reproduction opens at{' '}
              <code className="text-accent font-mono">{match.startRoute}</code>
              {match.feature ? ` in ${match.feature}.` : '.'}
            </>
          ) : (
            'No route in the report matched the crawl, so the test starts at the environment’s base URL.'
          )}
        </p>

        {match.matches.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {match.matches.map((route) => (
              <li key={route.reported} className="flex flex-wrap items-baseline gap-2">
                <code className="text-ink font-mono text-micro">{route.reported}</code>
                <span className="text-ink-faint text-micro">→</span>
                <code
                  className={`font-mono text-micro ${route.route ? 'text-accent' : 'text-fail'}`}
                >
                  {route.route ?? 'no match'}
                </code>
                <span className="text-ink-faint text-micro">
                  {HOW_LABEL[route.how] ?? route.how.toLowerCase()}
                </span>
                {route.offEnvironment && (
                  <Badge tone="flake">points at another origin</Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        {match.warnings.length > 0 && (
          <ul className="border-line mt-4 space-y-1.5 border-t pt-4">
            {match.warnings.map((warning) => (
              <li key={warning} className="text-flake text-micro leading-relaxed">
                {warning}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

// ─── 3. Already covered ──────────────────────────────────────────────────────

function Duplicate({
  duplicate,
  busy,
  onForce,
}: {
  duplicate: ReproDuplicate;
  busy: boolean;
  onForce: () => void;
}) {
  return (
    <section>
      <SectionLabel>This bug already has a test</SectionLabel>
      <Card className="border-accent/50 p-5">
        <p className="text-ink text-body-sm">
          <Link href={`/tests/${duplicate.testId}`} className="text-accent hover:underline">
            {duplicate.name}
          </Link>{' '}
          <span className="text-ink-faint font-mono text-micro">{duplicate.filePath}</span>
        </p>
        <p className="text-ink-dim text-body-sm mt-2 leading-relaxed">
          {duplicate.reasons.join('; ')}. No second test was written — a duplicate needs both a
          score over the threshold and two independent reasons, and this cleared both.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <Button loading={busy} onClick={onForce}>
            Write one anyway
          </Button>
          <span className="text-ink-faint text-micro">
            Sends the same report again with the duplicate check overridden.
          </span>
        </div>
      </Card>
    </section>
  );
}

// ─── 4. The proposed test ────────────────────────────────────────────────────

function Proposed({ result }: { result: ReproResponse }) {
  const { planItem, test, generation } = result;

  return (
    <section>
      <SectionLabel>The proposed test</SectionLabel>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{planItem.testType}</Badge>
          <Badge>{planItem.priority.toLowerCase().replace(/_/g, ' ')}</Badge>
          {planItem.feature && <Badge>{planItem.feature}</Badge>}
        </div>
        <h3 className="mt-2.5 text-base font-medium">{planItem.title}</h3>
        <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">{planItem.rationale}</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-ink-faint text-micro">Steps it will drive</p>
            <ol className="mt-1.5 space-y-1">
              {planItem.steps.map((step, i) => (
                <li key={`${i}-${step}`} className="text-ink text-body-sm flex gap-2.5">
                  <span className="text-ink-faint tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <p className="text-ink-faint text-micro">What it asserts</p>
            <ul className="mt-1.5 space-y-1.5">
              {planItem.assertions.map((assertion) => (
                <li key={assertion} className="text-ink text-body-sm leading-relaxed">
                  {assertion}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* A missing model is information, not a failure: everything above this
            line was derived from the report and the crawl without one. */}
        {generation?.skipped && (
          <div className="border-line bg-surface-2 mt-5 rounded-md border p-3.5">
            <p className="text-ink text-body-sm font-medium">No code was written</p>
            <p className="text-ink-dim text-body-sm mt-1 leading-relaxed">
              {generation.reason === 'ANTHROPIC_API_KEY is not set' ? (
                <>
                  This deployment has no model configured
                  (<code className="font-mono">ANTHROPIC_API_KEY</code> is unset), so the plan
                  above is as far as it goes. Everything in it — the steps, the assertions, the
                  start route, the duplicate check — was derived from your report and your
                  crawl, not generated, and stays true once a key is set.
                </>
              ) : (
                <>
                  {generation.reason}. The plan above is deterministic and stands on its own.
                </>
              )}
            </p>
          </div>
        )}

        {test && (
          <div className="border-line mt-5 border-t pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-ink text-body-sm font-medium">{test.name}</p>
              <code className="text-ink-faint font-mono text-micro">{test.filePath}</code>
            </div>
            {test.reviewFlags.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {test.reviewFlags.map((flag) => (
                  <li key={flag} className="text-flake text-micro leading-relaxed">
                    {flag}
                  </li>
                ))}
              </ul>
            )}
            <pre className="border-line bg-surface-2 text-ink-dim text-micro mt-3 max-h-80 overflow-auto rounded-md border p-3 font-mono">
              {test.code}
            </pre>
            <Link
              href={`/tests/${test.id}`}
              className="text-accent text-micro mt-2.5 inline-block font-medium hover:underline"
            >
              Open the test →
            </Link>
          </div>
        )}
      </Card>
    </section>
  );
}

// ─── 5. The run result, which is the whole point ─────────────────────────────

const VERDICT_STYLE: Record<
  ReproVerdict['outcome'],
  { wrap: string; text: string; label: string }
> = {
  REPRODUCED: {
    wrap: 'border-pass/50 bg-pass/10',
    text: 'text-pass',
    label: 'Reproduced',
  },
  // Loud. A green reproduction is the failure mode this whole screen exists to
  // prevent someone from misreading as a success.
  NOT_REPRODUCED: {
    wrap: 'border-fail/60 bg-fail/10',
    text: 'text-fail',
    label: 'Not reproduced',
  },
  INCONCLUSIVE: {
    wrap: 'border-flake/50 bg-flake/10',
    text: 'text-flake',
    label: 'Inconclusive',
  },
};

function RunResult({ result }: { result: ReproResponse }) {
  const { reproduction, run, test } = result;

  if (!reproduction) {
    return (
      <section>
        <SectionLabel>Did it reproduce?</SectionLabel>
        <Card className="border-flake/40 p-5">
          <p className="text-flake text-body-sm font-medium">Nothing has been reproduced.</p>
          <p className="text-ink-dim text-body-sm mt-1.5 leading-relaxed">
            No test was written, so none was run. A bug report is only reproduced once a test
            built from it has been watched to fail against the app.
          </p>
        </Card>
      </section>
    );
  }

  const style = VERDICT_STYLE[reproduction.outcome];

  return (
    <section>
      <SectionLabel>Did it reproduce?</SectionLabel>
      <div className={`rounded-lg border p-5 ${style.wrap}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-body-sm font-semibold tracking-wide uppercase ${style.text}`}>
            {style.label}
          </span>
          {reproduction.confirmed && <Badge tone="pass">failed for the reported reason</Badge>}
          {run?.result && (
            <span className="text-ink-dim text-micro tabular-nums">
              run status {run.result.status.toLowerCase()} · {duration(run.result.durationMs)}
            </span>
          )}
        </div>

        <p className={`mt-2 text-lg leading-snug font-semibold ${style.text}`}>
          {reproduction.headline}
        </p>
        <p className="text-ink-dim text-body-sm mt-2 max-w-3xl leading-relaxed">
          {reproduction.detail}
        </p>

        {reproduction.matchedReportedError && (
          <p className="text-ink-dim text-micro mt-3 font-mono break-words">
            matched: {reproduction.matchedReportedError}
          </p>
        )}

        {run?.result?.errorMessage && (
          <pre className="border-line bg-surface-2 text-ink-dim text-micro mt-3 max-h-48 overflow-auto rounded-md border p-3 font-mono whitespace-pre-wrap">
            {run.result.errorMessage}
          </pre>
        )}

        {test && (
          <p className="text-ink-dim text-body-sm mt-4">
            {test.enabled ? (
              <>
                The test is <span className="text-pass font-medium">enabled</span> and now part
                of the suite — it was allowed in because it was seen to fail.
              </>
            ) : (
              <>
                The test was left <span className="text-fail font-medium">disabled</span>. A
                reproduction nobody has seen fail is not allowed to join the suite that gates a
                merge, where it would sit green and tell every reader the bug is covered.
              </>
            )}
          </p>
        )}

        {run && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href={`/runs/${run.id}`}
              className="text-accent text-micro font-medium hover:underline"
            >
              Open the run →
            </Link>
            {!run.finished && (
              <span className="text-flake text-micro tabular-nums">
                Still running after {Math.round(run.waitedMs / 1000)}s — until it finishes,
                nothing is known either way.
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
