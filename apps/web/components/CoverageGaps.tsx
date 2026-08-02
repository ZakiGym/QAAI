'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../lib/api';
import type {
  CoverageFormSummary,
  CoverageGap,
  CoverageProposeResult,
  CoverageReport,
  GapConfidence,
  GapKind,
} from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { Badge, Card, SectionLabel, Skeleton } from './ui/layout';

/**
 * Coverage gaps — the tests nobody wrote.
 *
 * Every other reporting screen in this product describes tests that exist. This
 * one describes their absence, and that is a claim about somebody's work, so the
 * screen is built around the evidence rather than around the number. A row that
 * says "nothing tests /checkout" and makes you take its word for it is a row
 * that gets argued with once and ignored forever; the API returns `evidence[]`
 * for exactly that reason, so it renders inline on every gap, never behind a
 * disclosure.
 *
 * The two states people confuse are kept apart on purpose. "No flow map" means
 * the app was never crawled and we know nothing — it is NOT full coverage — and
 * it gets its own screen with its own action. Zero gaps on a real crawl is the
 * other thing entirely, and says so.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The API's enum, in words a person would use. */
const KIND_LABEL: Record<GapKind, string> = {
  UNVISITED_ROUTE: 'Untested route',
  UNREACHED_AUTH_ROUTE: 'Untested behind auth',
  UNWALKED_JOURNEY: 'Unwalked journey',
  UNSUBMITTED_FORM: 'Unsubmitted form',
  UNUSED_AFFORDANCE: 'Untouched control',
  NO_NEGATIVE_CASE: 'No error path',
};

/**
 * What a gap of this kind costs you, in one line. The kind name says what we
 * found; this says why it is on a list you are meant to act on.
 */
const KIND_MEANING: Record<GapKind, string> = {
  UNVISITED_ROUTE: 'The crawler reached this page. No test does.',
  UNREACHED_AUTH_ROUTE: 'Behind a sign-in wall, and no authenticated test gets there.',
  UNWALKED_JOURNEY: 'Tests touch the steps separately, so the hand-offs between them are unasserted.',
  UNSUBMITTED_FORM: 'A write path. Nothing fills it in or submits it.',
  UNUSED_AFFORDANCE: 'A control the crawl found and no test clicks.',
  NO_NEGATIVE_CASE: 'The feature has tests, and all of them only watch it succeed.',
};

const CONFIDENCE_TONE: Record<GapConfidence, 'neutral' | 'flake'> = {
  HIGH: 'neutral',
  MEDIUM: 'neutral',
  LOW: 'flake',
};

/** High score = act on this first, so the ramp runs neutral → flake → fail. */
function scoreTone(score: number): { text: string; bar: string } {
  if (score >= 70) return { text: 'text-fail', bar: 'bg-fail' };
  if (score >= 40) return { text: 'text-flake', bar: 'bg-flake' };
  return { text: 'text-ink-dim', bar: 'bg-line-strong' };
}

// ─── Data ────────────────────────────────────────────────────────────────────

export interface CoverageData {
  report: CoverageReport | null;
  /** testId → name, so "5 related tests" can name them. */
  testNames: Map<string, string>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * `projectSettling` is the shell still deciding which project is selected. It
 * has to hold the screen in its loading state — resolving it to "no project"
 * for one frame renders an empty state over a project that is about to arrive.
 */
export function useCoverage(projectId: string | null, projectSettling: boolean): CoverageData {
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [testNames, setTestNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (id: string) => {
    // Proposals come down with the report because they need no API key — they
    // are what /propose would write, before any model is involved — so the
    // preview is honest even on a deployment that cannot generate.
    const [coverage, tests] = await Promise.all([
      api<CoverageReport>(`/coverage/${id}?proposals=true`),
      // Names are a courtesy. If this fails the gaps still render, with ids.
      api<{ tests: Array<{ id: string; name: string }> }>(`/projects/${id}/tests`).catch(() => ({
        tests: [] as Array<{ id: string; name: string }>,
      })),
    ]);
    return { coverage, names: new Map(tests.tests.map((t) => [t.id, t.name])) };
  }, []);

  useEffect(() => {
    if (projectSettling) return;
    if (!projectId) {
      setReport(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Also on a project switch — the previous project's gaps must not sit there
    // looking like they belong to the one you just picked.
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const { coverage, names } = await fetchAll(projectId);
        if (cancelled) return;
        setReport(coverage);
        setTestNames(names);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Could not load the coverage report',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectSettling, fetchAll]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    const { coverage, names } = await fetchAll(projectId);
    setReport(coverage);
    setTestNames(names);
  }, [projectId, fetchAll]);

  return { report, testNames, loading: loading || projectSettling, error, reload };
}

// ─── The answer, before the list ─────────────────────────────────────────────

/**
 * The four ratios the headline is made of.
 *
 * A total of zero is rendered as "none found", not as 0% — a crawl that found
 * no forms is not a suite that fails to test them.
 */
function Ratio({
  label,
  covered,
  total,
}: {
  label: string;
  covered: number;
  total: number;
}) {
  const pct = total === 0 ? null : Math.round((covered / total) * 100);
  return (
    <div>
      <div className="text-ink-faint text-micro mb-1.5 flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {pct !== null && <span className="tabular-nums">{pct}%</span>}
      </div>
      {pct === null ? (
        <>
          <div className="bg-surface-2 h-1 rounded-full" />
          <p className="text-ink-faint text-meta mt-1.5">none found</p>
        </>
      ) : (
        <>
          <div className="bg-surface-2 h-1 overflow-hidden rounded-full">
            <div
              className={cn('h-full rounded-full', pct >= 60 ? 'bg-pass' : 'bg-flake')}
              style={{ width: `${Math.max(pct, 2)}%` }}
            />
          </div>
          <p className="text-ink-dim text-meta mt-1.5 tabular-nums">
            {covered} of {total} exercised
          </p>
        </>
      )}
    </div>
  );
}

/** The lead: the answer as a sentence, then the arithmetic under it. */
export function CoverageHeadline({
  report,
  compact = false,
}: {
  report: CoverageReport;
  compact?: boolean;
}) {
  const t = report.totals;
  const unreadable = t.tests - t.testsWithReadableRoutes;

  return (
    <Card className="p-5">
      <p className="text-lg leading-snug font-medium">
        You have <span className="tabular-nums">{t.tests}</span>{' '}
        {t.tests === 1 ? 'test' : 'tests'} and{' '}
        <span className={cn('tabular-nums', t.gaps > 0 && 'text-fail')}>{t.gaps}</span>{' '}
        untested {t.gaps === 1 ? 'surface' : 'surfaces'}.
      </p>
      <p className="text-ink-dim text-body-sm mt-1.5">
        Measured by putting what the crawler proved this app can do beside what the suite
        actually asserts
        {report.flowMapVersion !== null && (
          <>
            {' '}
            — crawl v<span className="tabular-nums">{report.flowMapVersion}</span>
          </>
        )}
        {report.baseUrl && <> of {report.baseUrl}</>}.
      </p>

      {!compact && (
        <div className="border-line mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-5 sm:grid-cols-4">
          <Ratio label="Routes" covered={t.routesVisited} total={t.routes} />
          <Ratio label="Journeys" covered={t.journeysWalked} total={t.journeys} />
          <Ratio label="Forms" covered={t.formsExercised} total={t.forms} />
          <Ratio label="Controls" covered={t.affordancesUsed} total={t.affordances} />
        </div>
      )}

      {unreadable > 0 && (
        <p className="text-ink-dim text-body-sm border-line mt-4 border-t pt-4">
          <span className="text-flake">Read this first:</span> {unreadable} of {t.tests} tests
          declare coverage this report could not read completely, so they are counted neither
          as coverage nor as a gap.
        </p>
      )}
    </Card>
  );
}

// ─── One gap ─────────────────────────────────────────────────────────────────

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-ink-faint text-meta mb-1 font-semibold tracking-wider uppercase">
        {label}
      </div>
      <div className="text-ink-dim text-body-sm">{children}</div>
    </div>
  );
}

function FormFields({ fields }: { fields: Array<{ label: string; required: boolean; semantic: string }> }) {
  if (fields.length === 0) return <span className="text-ink-faint">no fields</span>;
  return (
    <ul className="space-y-1">
      {fields.map((f, i) => (
        <li key={`${f.label}-${i}`} className="flex items-center gap-2">
          <code className="text-ink font-mono text-body-sm">{f.label}</code>
          <span className="text-ink-faint text-meta">{f.semantic.replace(/_/g, ' ')}</span>
          {f.required && <Badge tone="flake">required</Badge>}
        </li>
      ))}
    </ul>
  );
}

/**
 * One entry per distinct form.
 *
 * A route gap folds together every crawled page that shares the route — the
 * evidence says so out loud ("they are one gap, not 4") — so the same form
 * arrives once per page. Rendering the flattened field list turns that into
 * "Quantity, Quantity, Quantity, Quantity", which reads as four different
 * inputs and undersells the very deduplication the report just did.
 */
function uniqueForms(forms: CoverageFormSummary[]): CoverageFormSummary[] {
  const seen = new Map<string, CoverageFormSummary>();
  for (const form of forms) {
    const key = `${form.name}|${form.fields.map((f) => f.label).join(',')}`;
    if (!seen.has(key)) seen.set(key, form);
  }
  return [...seen.values()];
}

function FormList({ forms }: { forms: CoverageFormSummary[] }) {
  const unique = uniqueForms(forms);
  return (
    <div className="space-y-2">
      {unique.map((form, i) => (
        <div key={`${form.name}-${i}`}>
          <code className="text-ink-dim font-mono text-micro">{form.name}</code>
          <div className="mt-0.5 pl-3">
            <FormFields fields={form.fields} />
          </div>
        </div>
      ))}
      {unique.length < forms.length && (
        <p className="text-ink-faint text-meta">
          {forms.length - unique.length} identical copy(s) on other pages sharing this route are
          not repeated here.
        </p>
      )}
    </div>
  );
}

/** What the crawl saw, per subject kind. This is the raw material of the claim. */
function SubjectDetail({ gap }: { gap: CoverageGap }) {
  const s = gap.subject;
  switch (s.kind) {
    case 'route':
      return (
        <div className="space-y-3">
          <KeyValue label="Page">
            {s.title} {s.behindAuth && <Badge tone="flake">behind auth</Badge>}
          </KeyValue>
          {s.entryActions.length > 0 && (
            <KeyValue label="How the crawler got here">
              <ol className="list-inside list-decimal space-y-0.5">
                {s.entryActions.map((a, i) => (
                  <li key={i} className="font-mono text-body-sm">{a}</li>
                ))}
              </ol>
            </KeyValue>
          )}
          {s.forms.length > 0 && (
            <KeyValue label="Forms on this page">
              <FormList forms={s.forms} />
            </KeyValue>
          )}
        </div>
      );
    case 'journey':
      return (
        <div className="space-y-3">
          <KeyValue label="The path the crawl walked">
            <ol className="space-y-1">
              {s.routes.map((r, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-ink-faint text-meta w-4 shrink-0 tabular-nums">
                    {i + 1}
                  </span>
                  <code className="font-mono text-body-sm">{r}</code>
                  {s.steps[i] && (
                    <span className="text-ink-faint text-meta">via {s.steps[i]}</span>
                  )}
                </li>
              ))}
            </ol>
          </KeyValue>
          <KeyValue label="Explorer priority">{s.priority}</KeyValue>
        </div>
      );
    case 'form':
      return (
        <div className="space-y-3">
          <KeyValue label="Form">
            <code className="font-mono text-body-sm">{s.form.name}</code>
            {s.behindAuth && <Badge tone="flake" className="ml-2">behind auth</Badge>}
          </KeyValue>
          <KeyValue label="Fields">
            <FormFields fields={s.form.fields} />
          </KeyValue>
          {s.form.submitLabel && (
            <KeyValue label="Submit control">
              <code className="font-mono text-body-sm">{s.form.submitLabel}</code>
            </KeyValue>
          )}
        </div>
      );
    case 'affordance':
      return (
        <div className="space-y-3">
          <KeyValue label={`The ${s.controlKind}`}>{s.label}</KeyValue>
          <KeyValue label="Locator the crawl recorded">
            <code className="text-ink bg-surface-2 block rounded px-2 py-1.5 font-mono text-body-sm break-all">
              {s.expression}
            </code>
          </KeyValue>
        </div>
      );
    case 'negative':
      return (
        <div className="space-y-3">
          <KeyValue label="Feature">{s.feature}</KeyValue>
          <KeyValue label="Routes it covers">
            <div className="flex flex-wrap gap-1.5">
              {s.routes.map((r) => (
                <code key={r} className="bg-surface-2 rounded px-1.5 py-0.5 font-mono text-body-sm">
                  {r}
                </code>
              ))}
            </div>
          </KeyValue>
          {s.forms.length > 0 && (
            <KeyValue label="Input it accepts">
              <FormList forms={s.forms} />
            </KeyValue>
          )}
        </div>
      );
  }
}

function GapRow({
  gap,
  selected,
  onToggle,
  testNames,
}: {
  gap: CoverageGap;
  selected: boolean;
  onToggle: () => void;
  testNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const tone = scoreTone(gap.score);
  const detailId = `gap-detail-${gap.id}`;

  return (
    <Card className={cn('overflow-hidden', selected && 'border-accent/60')}>
      <div className="flex gap-4 p-4">
        <label className="flex shrink-0 cursor-pointer items-start pt-0.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="accent-accent h-4 w-4 cursor-pointer"
            aria-label={`Select: ${gap.title}`}
          />
        </label>

        {/* The rank, and the bar that says how much of the scale it is. */}
        <div className="w-9 shrink-0 text-center">
          <div className={cn('text-lg leading-none font-semibold tabular-nums', tone.text)}>
            {gap.score}
          </div>
          <div className="bg-surface-2 mt-1.5 h-1 overflow-hidden rounded-full">
            <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${gap.score}%` }} />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="accent">{KIND_LABEL[gap.kind]}</Badge>
            {gap.route && (
              <code className="text-ink-dim font-mono text-micro">{gap.route}</code>
            )}
            {gap.feature && <span className="text-ink-faint text-micro">{gap.feature}</span>}
            <Badge tone={CONFIDENCE_TONE[gap.confidence]} className="ml-auto">
              {gap.confidence} confidence
            </Badge>
          </div>

          <h3 className="text-ink text-sm leading-snug font-medium">{gap.title}</h3>
          <p className="text-ink-faint text-micro mt-1">{KIND_MEANING[gap.kind]}</p>

          {/*
           * Evidence is never behind a disclosure. A claim that a thing is
           * untested is only worth reading if the reason is on the same screen.
           */}
          <div className="border-line-strong mt-3 border-l-2 pl-3">
            <div className="text-ink-faint text-meta mb-1.5 font-semibold tracking-wider uppercase">
              Why we think so
            </div>
            <ul className="space-y-1.5">
              {gap.evidence.map((line, i) => (
                <li key={i} className="text-ink-dim text-body-sm leading-relaxed">
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            className="text-ink-faint hover:text-ink text-micro mt-3 inline-flex items-center gap-1.5 transition-colors"
          >
            <span className={cn('transition-transform', open && 'rotate-90')} aria-hidden="true">
              ▸
            </span>
            {open ? 'Hide' : 'What the crawl saw, and what a test would do'}
          </button>
        </div>
      </div>

      {open && (
        <div
          id={detailId}
          className="border-line bg-surface-2/40 grid gap-6 border-t p-4 md:grid-cols-2 md:pl-20"
        >
          <div className="space-y-4">
            <div>
              <SectionLabel>What the crawl saw</SectionLabel>
              <SubjectDetail gap={gap} />
            </div>

            <div>
              <SectionLabel>Ranked {gap.score} because</SectionLabel>
              <ul className="text-ink-dim text-body-sm space-y-1">
                {gap.scoreWhy.map((why, i) => (
                  <li key={i}>{why}</li>
                ))}
              </ul>
              <div className="text-ink-faint text-meta mt-2 flex gap-4 tabular-nums">
                <span>reachability {Math.round(gap.reachability * 100)}%</span>
                <span>blast radius {Math.round(gap.blastRadius * 100)}%</span>
              </div>
            </div>

            {gap.relatedTestIds.length > 0 && (
              <div>
                <SectionLabel>Nearby, but does not close it</SectionLabel>
                <ul className="text-ink-dim text-body-sm space-y-0.5">
                  {gap.relatedTestIds.map((id) => (
                    <li key={id} className="truncate">
                      {testNames.get(id) ?? (
                        <code className="font-mono text-micro">{id}</code>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div>
            <SectionLabel>What a test would do</SectionLabel>
            {gap.proposal ? (
              <div className="space-y-3">
                <p className="text-ink text-body-sm font-medium">{gap.proposal.title}</p>
                <div className="flex gap-1.5">
                  <Badge>{gap.proposal.testType}</Badge>
                  <Badge>{gap.proposal.priority}</Badge>
                </div>
                <div>
                  <div className="text-ink-faint text-meta mb-1 font-semibold tracking-wider uppercase">
                    Steps
                  </div>
                  <ol className="text-ink-dim text-body-sm list-inside list-decimal space-y-1">
                    {gap.proposal.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <div className="text-ink-faint text-meta mb-1 font-semibold tracking-wider uppercase">
                    Assertions
                  </div>
                  <ul className="text-ink-dim text-body-sm space-y-1">
                    {gap.proposal.assertions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="text-ink-dim text-body-sm">
                This gap has a shape the planner cannot turn into a test on its own. Everything
                above still holds — it needs a human to write the case.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── The propose result ──────────────────────────────────────────────────────

function ProposeResult({
  result,
  projectId,
  onClose,
}: {
  result: CoverageProposeResult;
  projectId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${result.items.length} plan ${result.items.length === 1 ? 'item' : 'items'} created`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => router.push(`/projects/${projectId}/plan`)}>
            Open the plan
          </Button>
        </>
      }
    >
      {/*
       * Items first, explanation second — the server's own sentence says "the
       * plan items above", and it is right about what matters here. What was
       * written is the result; whether a model got to run on it afterwards is
       * the footnote.
       */}
      <SectionLabel>The items</SectionLabel>
      <ul className="divide-line border-line mb-4 divide-y rounded-md border">
        {result.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="text-ink text-body-sm min-w-0 flex-1 truncate">{item.title}</span>
            <Badge>{item.testType}</Badge>
            <Badge>{item.priority}</Badge>
          </li>
        ))}
      </ul>

      {/*
       * A deployment with no API key is a MISSING TOOL, not a failure. The
       * deterministic half of the request is done and worth having, so this is
       * a plain statement in the normal palette rather than an error.
       */}
      {result.generation.queued ? (
        <p className="text-ink-dim text-body-sm">
          The Generator is writing code for these now
          {result.jobId && (
            <>
              {' '}
              (job <code className="font-mono text-micro">{result.jobId}</code>)
            </>
          )}
          . Approving the plan is what turns them into tests.
        </p>
      ) : (
        <div className="border-line bg-surface-2 text-ink-dim text-body-sm rounded-md border p-3 leading-relaxed">
          {result.generation.reason ?? 'The Generator was not run for these items.'}
        </div>
      )}

      {result.skippedGapIds.length > 0 && (
        <p className="text-ink-faint text-micro mt-3">
          {result.skippedGapIds.length} selected{' '}
          {result.skippedGapIds.length === 1 ? 'gap was' : 'gaps were'} no longer in the report
          and {result.skippedGapIds.length === 1 ? 'was' : 'were'} skipped.
        </p>
      )}
    </Modal>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────

export function CoverageGaps({
  projectId,
  data,
}: {
  projectId: string | null;
  data: CoverageData;
}) {
  const { report, testNames, loading, error, reload } = data;
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<GapKind>>(new Set());
  const [proposing, setProposing] = useState(false);
  const [result, setResult] = useState<CoverageProposeResult | null>(null);

  // A report that reloads underneath a selection would let somebody propose a
  // gap they never ticked.
  useEffect(() => {
    setSelected(new Set());
  }, [report?.fingerprint]);

  const kindCounts = useMemo(() => {
    const counts = new Map<GapKind, number>();
    for (const gap of report?.gaps ?? []) counts.set(gap.kind, (counts.get(gap.kind) ?? 0) + 1);
    return counts;
  }, [report]);

  const visible = useMemo(
    () => (report?.gaps ?? []).filter((g) => kinds.size === 0 || kinds.has(g.kind)),
    [report, kinds],
  );

  const maxPropose = report?.limits.maxProposalsPerRequest ?? 25;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function propose() {
    if (!projectId || !report || selected.size === 0) return;
    setProposing(true);
    try {
      const proposal = await api<CoverageProposeResult>(`/coverage/${projectId}/propose`, {
        method: 'POST',
        body: JSON.stringify({
          gapIds: [...selected],
          // Sent so a stale screen is told, rather than quietly handed a test
          // for a gap somebody already closed.
          fingerprint: report.fingerprint,
        }),
      });
      setResult(proposal);
      // Cleared explicitly rather than left to the fingerprint effect: proposing
      // does not change the report, so the fingerprint holds and the ticks would
      // survive — one more click away from minting the same plan twice.
      setSelected(new Set());
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          'The coverage report changed since this page loaded — tests were added, or the app was re-crawled. It has been re-read, so choose again.',
        );
        await reload().catch(() => {});
      } else {
        toast.error(err instanceof Error ? err.message : 'Could not propose tests');
      }
    } finally {
      setProposing(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Card className="p-5">
          <Skeleton className="h-6 w-80" />
          <Skeleton className="mt-2 h-3 w-96" />
          <div className="border-line mt-5 grid grid-cols-2 gap-6 border-t pt-5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <Skeleton className="mb-2 h-2.5 w-16" />
                <Skeleton className="h-1 w-full" />
                <Skeleton className="mt-2 h-2 w-20" />
              </div>
            ))}
          </div>
        </Card>
        {[0, 1, 2].map((i) => (
          <Card key={i} className="space-y-2.5 p-4">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="border-fail/40 bg-fail/10 text-fail rounded-md border p-3 text-sm">{error}</p>
    );
  }

  if (!projectId || !report) {
    return (
      <EmptyState
        title="No project selected"
        body="Coverage is computed per app. Pick one in the sidebar and this fills in."
      />
    );
  }

  /*
   * The distinction the whole feature turns on. No crawl means we know nothing
   * about the application — it is the opposite of a clean bill of health, and
   * saying "no gaps" here would be the single most damaging thing this screen
   * could do.
   */
  if (!report.crawled) {
    return (
      <EmptyState
        title="This app has never been crawled"
        body="Coverage is measured by putting what the crawler proved your app can do beside what the tests assert. With no flow map there is no first half, so there is nothing to compare — which is not the same as being fully covered."
        action={{ label: 'Open the flow map', href: '/flow-map' }}
      />
    );
  }

  return (
    <>
      <CoverageHeadline report={report} />

      {report.caveats.length > 0 && (
        <div className="border-flake/40 bg-flake/10 mt-4 rounded-md border p-3">
          <div className="text-flake text-meta mb-1.5 font-semibold tracking-wider uppercase">
            Before you trust these numbers
          </div>
          <ul className="text-ink-dim text-body-sm space-y-1">
            {report.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {report.unreadable.length > 0 && (
        <p className="text-ink-dim text-body-sm mt-4">
          {report.unreadable.length} part(s) of the flow map could not be read:{' '}
          {report.unreadable.join('; ')}
        </p>
      )}

      {report.unknowns.length > 0 && (
        <Card className="mt-4 p-4">
          <SectionLabel>
            {report.unknowns.length} test(s) whose coverage could not be read
          </SectionLabel>
          <p className="text-ink-dim text-body-sm mb-3">
            Neither a gap nor coverage — the third state. Read the count above knowing these
            were not counted either way.
          </p>
          <ul className="divide-line divide-y">
            {report.unknowns.map((u) => (
              <li key={u.testId} className="py-2">
                <div className="text-ink text-body-sm">{u.name}</div>
                <div className="text-ink-faint text-micro font-mono">{u.filePath}</div>
                <div className="text-ink-dim text-body-sm mt-1">{u.reason}</div>
                {u.sample && (
                  <code className="bg-surface-2 text-ink-dim mt-1 block rounded px-2 py-1 font-mono text-micro break-all">
                    {u.sample}
                  </code>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.gaps.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Every surface the crawl found is exercised"
            body={`Crawl v${report.flowMapVersion ?? '?'} found ${report.totals.routes} route(s), ${report.totals.journeys} journey(s), ${report.totals.forms} form(s) and ${report.totals.affordances} control(s), and a test touches all of them. New gaps appear when the app grows or the Explorer runs again.`}
            action={{ label: 'Re-crawl the app', href: '/flow-map' }}
          />
        </div>
      ) : (
        <>
          {/* Filters. Client-side over the report already in hand, so the
              fingerprint the selection was made against never moves. */}
          <div className="border-line mt-8 mb-4 flex flex-wrap items-center gap-2 border-b pb-4">
            <button
              type="button"
              onClick={() => setKinds(new Set())}
              className={cn(
                'text-micro rounded-full border px-2.5 py-1 transition-colors',
                kinds.size === 0
                  ? 'border-accent text-accent'
                  : 'border-line text-ink-dim hover:text-ink',
              )}
            >
              All <span className="tabular-nums">{report.gaps.length}</span>
            </button>
            {[...kindCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() =>
                    setKinds((prev) => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  className={cn(
                    'text-micro rounded-full border px-2.5 py-1 transition-colors',
                    kinds.has(kind)
                      ? 'border-accent text-accent'
                      : 'border-line text-ink-dim hover:text-ink',
                  )}
                >
                  {KIND_LABEL[kind]} <span className="tabular-nums">{count}</span>
                </button>
              ))}

            <div className="ml-auto flex items-center gap-2">
              <span className="text-ink-faint text-micro tabular-nums">
                {visible.length} shown
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSelected(new Set(visible.slice(0, maxPropose).map((g) => g.id)))
                }
              >
                Select top {Math.min(visible.length, maxPropose)}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {visible.map((gap) => (
              <GapRow
                key={gap.id}
                gap={gap}
                selected={selected.has(gap.id)}
                onToggle={() => toggle(gap.id)}
                testNames={testNames}
              />
            ))}
          </div>

          {selected.size > 0 && (
            <div className="sticky bottom-6 z-20 mt-6">
              <div className="border-accent/50 bg-surface-1 flex items-center gap-4 rounded-lg border p-3 shadow-lg">
                <span className="text-body-sm">
                  <span className="tabular-nums font-medium">{selected.size}</span> gap
                  {selected.size === 1 ? '' : 's'} selected
                </span>
                {selected.size > maxPropose && (
                  <span className="text-flake text-micro">
                    the endpoint takes {maxPropose} at a time — deselect{' '}
                    <span className="tabular-nums">{selected.size - maxPropose}</span>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={proposing}
                    disabled={selected.size > maxPropose}
                    onClick={propose}
                  >
                    Propose {selected.size} test{selected.size === 1 ? '' : 's'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {result && projectId && (
        <ProposeResult result={result} projectId={projectId} onClose={() => setResult(null)} />
      )}
    </>
  );
}
