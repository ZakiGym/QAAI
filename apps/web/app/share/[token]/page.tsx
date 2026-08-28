'use client';

import { use, useEffect, useState } from 'react';
import { API_URL, ApiError, api } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { wallClock } from '../../../components/runs/format';
import { duration } from '../../../components/ui';

/**
 * The public run report.
 *
 * This is the most public thing QAAI has: it is opened by a developer who has
 * no login, was sent a URL in a chat message, and has never seen this product.
 * So it is written for somebody who arrives with no context — the headline says
 * what happened in a sentence, the evidence is laid out in reading order rather
 * than in a triage cockpit's three columns, and every piece of jargon the API
 * returns (`FLAKY`, `P1`, `ACCESSIBILITY`) is either explained or dropped.
 *
 * Two things about it are load-bearing and easy to lose in a redesign:
 *
 *  1. IT SAYS WHAT IT IS NOT SHOWING. The API withholds the browser console,
 *     the network bodies, the trace and the video, and it returns the counts of
 *     each. Rendering the report without that panel would send the reader
 *     hunting for a cause that is sitting in the part they cannot see. The
 *     panel is not a footnote; it sits with the evidence.
 *
 *  2. IT NEVER ASKS FOR A LOGIN. Not a banner, not a "sign in for more" on the
 *     withheld panel, not a redirect on an expired link. The person reading this
 *     is being asked to fix a bug, not to evaluate a product; the one link out
 *     is in the footer and it is small.
 *
 * ── Why the page is a fixed overlay ─────────────────────────────────────────
 *
 * `AppShell` renders the signed-in frame — sidebar, command palette — around
 * everything except the four paths in `SHELL_EXCLUDED` (components/shell/nav.ts),
 * and that set is exact paths, so a dynamic route cannot join it without editing
 * that file. Until `/share/` is added there as a prefix, this page covers the
 * frame rather than sitting inside it. The shell's own fetches all fail soft on
 * a 401, so nothing behind this is doing anything; it is only a matter of not
 * showing an anonymous visitor a navigation they cannot use.
 */

interface PublicStep {
  index: number;
  title: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  errorMessage: string | null;
  errorStack: string | null;
  selector: string | null;
  expected: string | null;
  actual: string | null;
  /** The id to fetch this step's screenshot with, or null if it kept none. */
  screenshot: string | null;
}

interface PublicFinding {
  id: string;
  kind: string;
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  code: string;
  message: string | null;
  location: string;
  helpUrl: string | null;
}

interface PublicNetworkEntry {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  thirdParty: boolean;
}

interface PublicResult {
  name: string;
  type: string;
  priority: string;
  filePath: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
  retriedAndPassed: boolean;
  steps: PublicStep[];
  findings: PublicFinding[];
  network: PublicNetworkEntry[];
  networkTotal: number;
  consoleTotal: number;
}

interface PublicReport {
  reference: string;
  status: string;
  trigger: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  totals: { total: number; passed: number; failed: number; flaky: number; skipped: number };
  errorMessage: string | null;
  stopReason: string | null;
  branch: string | null;
  commitSha: string | null;
  prNumber: number | null;
  environment: { name: string; kind: string };
  results: PublicResult[];
  truncatedResults: number;
  withheld: Array<{ what: string; detail: string }>;
  expiresAt: string | null;
}

const FAILED_STATUSES = new Set(['FAILED', 'TIMED_OUT', 'FLAKY']);

/** The status word, in the plainest English the status supports. */
const RESULT_WORD: Record<string, { word: string; tone: string }> = {
  PASSED: { word: 'passed', tone: 'text-pass' },
  FAILED: { word: 'failed', tone: 'text-fail' },
  TIMED_OUT: { word: 'timed out', tone: 'text-fail' },
  FLAKY: { word: 'passed on retry', tone: 'text-flake' },
  SKIPPED: { word: 'skipped', tone: 'text-ink-faint' },
};

/**
 * The one sentence at the top.
 *
 * A stranger reads exactly this before deciding whether the message they were
 * sent is worth their next ten minutes, so it is a sentence and not a status
 * enum. ERRORED is called out separately because a run that never got to its
 * tests is not a run whose tests failed — the second is about their code and
 * the first is not.
 */
function headline(report: PublicReport): string {
  const { total, failed, flaky } = report.totals;
  if (report.status === 'ERRORED') return 'This run did not finish';
  if (report.status === 'CANCELLED') return 'This run was stopped';
  if (report.status === 'QUEUED' || report.status === 'RUNNING') return 'This run is still going';
  if (failed > 0) {
    return `${failed} of ${total} test${total === 1 ? '' : 's'} failed`;
  }
  if (flaky > 0) return `${flaky} test${flaky === 1 ? '' : 's'} only passed on a retry`;
  return `All ${total} test${total === 1 ? '' : 's'} passed`;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SharedRunPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [report, setReport] = useState<PublicReport | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { report } = await api<{ report: PublicReport }>(
          `/share/${encodeURIComponent(token)}`,
        );
        if (!cancelled) setReport(report);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? { code: err.code, message: err.message }
            : { code: 'UNKNOWN', message: 'This report could not be loaded.' },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    /*
     * `fixed inset-0`, and see the note at the top of the file: this page has to
     * cover the signed-in shell it is currently rendered inside.
     */
    <div className="bg-surface text-ink fixed inset-0 z-50 overflow-y-auto">
      {/*
        A public URL is a credential — a search engine that finds one has
        published it. React 19 hoists this into <head>, and the API sends the
        matching X-Robots-Tag on the JSON and the images.
      */}
      <meta name="robots" content="noindex, nofollow" />

      <header className="border-line bg-surface-1 border-b">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-x-3 gap-y-1 px-6 py-3">
          <span className="font-display text-[15px] font-semibold tracking-tight">QAAI</span>
          <span className="text-ink-faint text-micro font-mono tracking-[0.08em] uppercase">
            shared test report · read only
          </span>
          {report?.expiresAt && (
            <span className="text-ink-faint ml-auto text-[11.5px]">
              link expires {when(report.expiresAt)}
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[880px] px-6 pt-10 pb-24">
        {error ? (
          <LinkProblem code={error.code} message={error.message} />
        ) : !report ? (
          <ReportSkeleton />
        ) : (
          <Report report={report} onZoom={setZoomed} token={token} />
        )}
      </main>

      {zoomed && (
        <button
          type="button"
          aria-label="Close the screenshot"
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
        >
          {/* A plain <img>, not next/image: these bytes are proxied by the API
              behind the share token, so the optimiser would need a loader and a
              remote-pattern allowlist for a URL that is different per visitor —
              and would cache a picture a revocation is supposed to take away. */}
          <img
            src={`${API_URL}/share/${encodeURIComponent(token)}/screenshot/${zoomed}`}
            alt="Screenshot at the moment the step ran, full size"
            className="max-h-full max-w-full rounded-lg"
          />
        </button>
      )}
    </div>
  );
}

// ─── The report ──────────────────────────────────────────────────────────────

function Report({
  report,
  token,
  onZoom,
}: {
  report: PublicReport;
  token: string;
  onZoom: (stepId: string) => void;
}) {
  /*
   * Failures first, and it is the whole information architecture of the page.
   * The API returns results in run order, which on a 40-test suite buries the
   * one thing the reader was sent here to look at under thirty-nine passes.
   */
  const failures = report.results.filter((r) => FAILED_STATUSES.has(r.status));
  const rest = report.results.filter((r) => !FAILED_STATUSES.has(r.status));
  const elapsed =
    report.startedAt && report.finishedAt
      ? new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime()
      : null;

  return (
    <>
      <h1 className="font-display text-display-lg leading-[1.15] font-semibold">
        {headline(report)}
      </h1>

      <p className="text-ink-dim mt-3 text-body-sm">
        {report.environment.name} · {report.trigger.toLowerCase()} run · {when(report.queuedAt)}
        {elapsed !== null && <> · took {wallClock(elapsed)}</>}
      </p>

      {/* The CI context: their branch, their commit, their PR. It is what turns
          "a test failed" into "a test failed on the change I just pushed". */}
      {(report.branch || report.commitSha || report.prNumber !== null) && (
        <p className="text-ink-faint mt-1.5 font-mono text-[12px]">
          {report.branch}
          {report.commitSha && <> · {report.commitSha}</>}
          {report.prNumber !== null && <> · PR #{report.prNumber}</>}
        </p>
      )}

      <Counts totals={report.totals} />

      {report.errorMessage && (
        <p className="border-fail/40 bg-fail/8 text-fail mt-6 rounded-lg border px-4 py-3 text-body-sm">
          {report.errorMessage}
        </p>
      )}
      {report.stopReason && (
        <p className="border-line bg-surface-1 text-ink-dim mt-3 rounded-lg border px-4 py-3 text-body-sm">
          {report.stopReason}
        </p>
      )}

      {failures.map((result, index) => (
        <Failure
          key={`${result.filePath}:${result.name}:${index}`}
          result={result}
          token={token}
          onZoom={onZoom}
        />
      ))}

      <Withheld notes={report.withheld} />

      {rest.length > 0 && <Others results={rest} />}

      {report.truncatedResults > 0 && (
        <p className="text-ink-faint mt-6 text-body-sm">
          {report.truncatedResults} more result
          {report.truncatedResults === 1 ? ' is' : 's are'} not shown — this report is capped so it
          stays readable.
        </p>
      )}

      <footer className="border-line text-ink-faint mt-16 border-t pt-6 text-[12px]">
        <p>
          Report <span className="font-mono">{report.reference}</span>, produced by QAAI — an AI QA
          engineer that runs a test suite and explains what broke.
        </p>
        <p className="mt-1.5">
          Whoever sent you this link can turn it off at any time, and it only ever showed this one
          run.
        </p>
      </footer>
    </>
  );
}

function Counts({ totals }: { totals: PublicReport['totals'] }) {
  const cells: Array<{ label: string; value: number; tone: string }> = [
    { label: 'failed', value: totals.failed, tone: 'text-fail' },
    { label: 'passed on retry', value: totals.flaky, tone: 'text-flake' },
    { label: 'passed', value: totals.passed, tone: 'text-pass' },
    { label: 'skipped', value: totals.skipped, tone: 'text-ink-faint' },
  ];

  return (
    <div className="border-line mt-7 flex flex-wrap gap-x-10 gap-y-4 rounded-lg border px-5 py-4">
      {cells
        // A zero is not information here. Four counts with three zeroes reads as
        // a dashboard; one number reads as an answer.
        .filter((cell) => cell.value > 0)
        .map((cell) => (
          <div key={cell.label}>
            <p className={cn('font-display text-stat leading-none font-semibold', cell.tone)}>
              {cell.value}
            </p>
            <p className="text-ink-faint text-micro mt-1.5 font-mono tracking-[0.08em] uppercase">
              {cell.label}
            </p>
          </div>
        ))}
    </div>
  );
}

/**
 * One failing test, told as a story: what it was doing, where it stopped, what
 * it expected, and a picture of the screen at that moment.
 */
function Failure({
  result,
  token,
  onZoom,
}: {
  result: PublicResult;
  token: string;
  onZoom: (stepId: string) => void;
}) {
  const failingStep = result.steps.find((s) => s.status === 'FAILED') ?? null;
  const word = RESULT_WORD[result.status] ?? { word: result.status.toLowerCase(), tone: 'text-ink' };
  // The screenshot worth showing is the one from the step that broke; failing
  // that, the last one the test managed to take before it stopped.
  const shot =
    failingStep?.screenshot ??
    [...result.steps].reverse().find((s) => s.screenshot)?.screenshot ??
    null;

  return (
    <section className="mt-14">
      <h2 className="font-display text-display-sm leading-snug font-semibold">{result.name}</h2>
      <p className="text-ink-faint mt-1 font-mono text-[12px]">
        {result.filePath} · <span className={word.tone}>{word.word}</span> after{' '}
        {duration(result.durationMs)}
      </p>

      {result.retriedAndPassed && (
        <p className="border-flake/40 bg-flake/8 text-flake mt-4 rounded-lg border px-4 py-3 text-body-sm">
          This test failed and then passed when it was retried. That usually means the failure is
          intermittent rather than absent.
        </p>
      )}

      {(failingStep?.errorMessage ?? result.errorMessage) && (
        <pre className="border-fail/40 bg-fail/8 text-fail mt-5 overflow-x-auto rounded-lg border px-4 py-3.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {failingStep?.errorMessage ?? result.errorMessage}
        </pre>
      )}

      {failingStep && (
        <Expectation
          selector={failingStep.selector}
          expected={failingStep.expected}
          actual={failingStep.actual}
        />
      )}

      {shot && (
        <figure className="mt-6">
          <button
            type="button"
            onClick={() => onZoom(shot)}
            className="border-line hover:border-line-strong block w-full cursor-zoom-in overflow-hidden rounded-lg border transition-colors"
          >
            {/* A plain <img> — see the note on the lightbox above. */}
            <img
              src={`${API_URL}/share/${encodeURIComponent(token)}/screenshot/${shot}`}
              alt={`The screen when "${failingStep?.title ?? result.name}" ran`}
              className="block w-full"
            />
          </button>
          <figcaption className="text-ink-faint mt-2 text-[11.5px]">
            The page at the moment this step ran. Click to enlarge.
          </figcaption>
        </figure>
      )}

      <Steps steps={result.steps} />

      {result.findings.length > 0 && <Findings findings={result.findings} />}

      {result.networkTotal > 0 && <Network result={result} />}

      {failingStep?.errorStack && (
        <details className="mt-5">
          <summary className="text-ink-dim hover:text-ink cursor-pointer text-body-sm">
            Stack trace
          </summary>
          <pre className="border-line bg-surface-1 text-ink-dim mt-2 overflow-x-auto rounded-lg border px-4 py-3 font-mono text-[12px] whitespace-pre-wrap">
            {failingStep.errorStack}
          </pre>
        </details>
      )}
    </section>
  );
}

/**
 * Expected versus actual, side by side.
 *
 * Two lines of a diff, and the single most useful thing on the page for anybody
 * who has not read the test — it says what the test believed without making
 * them go and read its source.
 */
function Expectation({
  selector,
  expected,
  actual,
}: {
  selector: string | null;
  expected: string | null;
  actual: string | null;
}) {
  if (!selector && !expected && !actual) return null;

  return (
    <dl className="border-line mt-5 divide-y divide-[var(--color-line)] rounded-lg border">
      {selector && <Row term="looking for" value={selector} />}
      {expected && <Row term="expected" value={expected} tone="text-pass" />}
      {actual && <Row term="found" value={actual} tone="text-fail" />}
    </dl>
  );
}

function Row({ term, value, tone }: { term: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5">
      <dt className="text-ink-faint text-micro w-[86px] shrink-0 pt-[3px] font-mono tracking-[0.08em] uppercase">
        {term}
      </dt>
      <dd className={cn('min-w-0 flex-1 font-mono text-[12.5px] break-words', tone ?? 'text-ink')}>
        {value}
      </dd>
    </div>
  );
}

/** Every step the test took, so the failure has a before as well as an after. */
function Steps({ steps }: { steps: PublicStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol className="mt-6">
      {steps.map((step) => {
        const failed = step.status === 'FAILED';
        return (
          <li
            key={step.index}
            className={cn(
              'flex items-baseline gap-3 border-l-2 py-1.5 pl-3.5',
              failed ? 'border-fail' : 'border-line',
            )}
          >
            <span className="text-ink-faint font-mono text-[11.5px] tabular-nums">
              {String(step.index + 1).padStart(2, '0')}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 text-body-sm',
                failed ? 'text-ink font-medium' : step.status === 'SKIPPED' ? 'text-ink-faint' : 'text-ink-dim',
              )}
            >
              {step.title}
              {step.status === 'SKIPPED' && (
                <span className="text-ink-faint"> — never ran, the test had already stopped</span>
              )}
            </span>
            <span className="text-ink-faint font-mono text-[11.5px] tabular-nums">
              {duration(step.durationMs)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: 'text-fail',
  SERIOUS: 'text-fail/80',
  MODERATE: 'text-flake',
  MINOR: 'text-ink-faint',
};

/** Accessibility, security, performance and localisation issues found on the way. */
function Findings({ findings }: { findings: PublicFinding[] }) {
  return (
    <div className="mt-7">
      <h3 className="text-ink-faint text-micro font-mono tracking-[0.08em] uppercase">
        Also found on this page
      </h3>
      <ul className="border-line mt-2.5 divide-y divide-[var(--color-line)] rounded-lg border">
        {findings.map((finding) => (
          <li key={finding.id} className="px-4 py-3">
            <p className="flex flex-wrap items-baseline gap-x-2.5 text-body-sm">
              <span
                className={cn(
                  'text-meta font-mono tracking-[0.05em]',
                  SEVERITY_TONE[finding.severity] ?? 'text-ink-faint',
                )}
              >
                {finding.severity}
              </span>
              <span className="text-ink-faint text-[11.5px] lowercase">
                {finding.kind.toLowerCase()}
              </span>
              <span className="min-w-0 flex-1">{finding.message ?? finding.code}</span>
            </p>
            <p className="text-ink-faint mt-1 font-mono text-[11.5px]">
              {finding.location}
              {finding.helpUrl && (
                <>
                  {' · '}
                  <a
                    href={finding.helpUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    how to fix it
                  </a>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The network log, as much of it as is safe to publish.
 *
 * Hosts, query strings and bodies are stripped by the API before this page ever
 * sees them, and the caption says so rather than letting the reader assume the
 * paths are the whole truth.
 */
function Network({ result }: { result: PublicResult }) {
  return (
    <details className="mt-5">
      <summary className="text-ink-dim hover:text-ink cursor-pointer text-body-sm">
        {result.networkTotal} network request{result.networkTotal === 1 ? '' : 's'}
      </summary>
      <table className="mt-2.5 w-full text-left font-mono text-[12px]">
        <tbody>
          {result.network.map((entry, index) => (
            <tr key={`${entry.method}:${entry.path}:${index}`} className="border-line border-b">
              <td className="text-ink-faint py-1.5 pr-3 align-top">{entry.method}</td>
              <td className="text-ink-dim py-1.5 pr-3 break-all">
                {entry.path}
                {entry.thirdParty && (
                  <span className="text-ink-faint"> · third party</span>
                )}
              </td>
              <td
                className={cn(
                  'py-1.5 pr-3 text-right align-top tabular-nums',
                  entry.status !== null && entry.status >= 400 ? 'text-fail' : 'text-ink-faint',
                )}
              >
                {entry.status ?? '—'}
              </td>
              <td className="text-ink-faint py-1.5 text-right align-top tabular-nums">
                {duration(entry.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-ink-faint mt-2 text-[11.5px]">
        Hostnames, query strings, headers and bodies are not included, and id-shaped parts of a path
        are replaced with <span className="font-mono">:id</span>.
        {result.network.length < result.networkTotal && (
          <> Showing the first {result.network.length}.</>
        )}
      </p>
    </details>
  );
}

/**
 * What this report does not contain.
 *
 * Placed with the evidence rather than in the footer, and worded as a fact
 * rather than an apology. A reader who knows the console was withheld asks a
 * colleague for it; a reader who does not know assumes there was nothing in it.
 */
function Withheld({ notes }: { notes: PublicReport['withheld'] }) {
  if (notes.length === 0) return null;

  return (
    <section className="border-line bg-surface-1 mt-14 rounded-lg border px-5 py-4">
      <h2 className="text-ink text-body-sm font-semibold">What this report leaves out</h2>
      <p className="text-ink-dim mt-1.5 text-body-sm">
        A test run records more than a failure. The parts that routinely carry access tokens or
        customer data are not published to a link anyone can open.
      </p>
      <dl className="mt-4 space-y-3">
        {notes.map((note) => (
          <div key={note.what}>
            <dt className="text-ink text-body-sm font-medium">{note.what}</dt>
            <dd className="text-ink-dim mt-0.5 text-[12.5px] leading-relaxed">{note.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Everything that did not fail, kept short. */
function Others({ results }: { results: PublicResult[] }) {
  return (
    <section className="mt-14">
      <h2 className="text-ink-faint text-micro font-mono tracking-[0.08em] uppercase">
        The rest of the run
      </h2>
      <ul className="border-line mt-2.5 divide-y divide-[var(--color-line)] rounded-lg border">
        {results.map((result, index) => {
          const word = RESULT_WORD[result.status] ?? {
            word: result.status.toLowerCase(),
            tone: 'text-ink-faint',
          };
          return (
            <li
              key={`${result.filePath}:${result.name}:${index}`}
              className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-body-sm"
            >
              <span className={cn('font-mono text-[11.5px]', word.tone)}>{word.word}</span>
              <span className="text-ink-dim min-w-0 flex-1">{result.name}</span>
              <span className="text-ink-faint font-mono text-[11.5px] tabular-nums">
                {duration(result.durationMs)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ─── The three ways a link can fail ──────────────────────────────────────────

/**
 * Revoked, expired and unknown are three different sentences.
 *
 * All three used to be one 404 in every design sketch of this page, and that is
 * the version where a developer concludes the tool is broken rather than that
 * the link needs re-sending. None of them offers a sign-in — the reader almost
 * certainly has no account, and a login wall is a dead end dressed as help.
 */
function LinkProblem({ code, message }: { code: string; message: string }) {
  const copy: Record<string, { title: string; body: string }> = {
    LINK_REVOKED: {
      title: 'This link was turned off',
      body: 'The team that shared this run has revoked the link. Ask them for a new one — it takes them one click.',
    },
    LINK_EXPIRED: {
      title: 'This link has expired',
      body: 'Share links are given a deadline when they are created. Ask whoever sent it for a fresh one.',
    },
    NOT_FOUND: {
      title: 'This link does not exist',
      body: 'It may have been mistyped, or cut in half by the app it was pasted into. Check you have the whole URL.',
    },
  };
  const { title, body } = copy[code] ?? { title: 'This report could not be loaded', body: message };

  return (
    <div className="pt-16">
      <h1 className="font-display text-display leading-tight font-semibold">{title}</h1>
      <p className="text-ink-dim mt-3 max-w-[52ch] text-body-sm">{body}</p>
    </div>
  );
}

/** Shaped like the report, so the wait says what it is waiting for. */
function ReportSkeleton() {
  return (
    <div role="status" aria-label="Loading the report" className="animate-pulse">
      <div className="bg-surface-2 h-9 w-[22rem] max-w-full rounded" />
      <div className="bg-surface-2 mt-4 h-3.5 w-64 rounded" />
      <div className="border-line mt-7 h-[86px] rounded-lg border" />
      <div className="bg-surface-2 mt-14 h-6 w-80 max-w-full rounded" />
      <div className="border-line mt-5 h-24 rounded-lg border" />
      <div className="border-line mt-6 h-64 rounded-lg border" />
    </div>
  );
}
