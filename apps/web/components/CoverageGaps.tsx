'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../lib/api';
import type {
  CoverageFormSummary,
  CoverageGap,
  CoverageProposeResult,
  CoverageReport,
  GapKind,
} from '../lib/api';
import { cn } from '../lib/cn';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';
import { Badge, SectionLabel, Skeleton } from './ui/layout';

/**
 * Coverage gaps — the tests nobody wrote.
 *
 * Every other reporting screen in this product describes tests that exist. This
 * one describes their absence, and that is a claim about somebody's work, so the
 * screen is built around the evidence rather than around the number. A row that
 * says "nothing tests /checkout" and makes you take its word for it is a row
 * that gets argued with once and ignored forever; the API returns `evidence[]`
 * for exactly that reason, so the first line of it is ON the row — never behind
 * a disclosure — and the rest is one click away with the rank and the proposal.
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
  UNWALKED_JOURNEY:
    'Tests touch the steps separately, so the hand-offs between them are unasserted.',
  UNSUBMITTED_FORM: 'A write path. Nothing fills it in or submits it.',
  UNUSED_AFFORDANCE: 'A control the crawl found and no test clicks.',
  NO_NEGATIVE_CASE: 'The feature has tests, and all of them only watch it succeed.',
};

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
        setError(err instanceof Error ? err.message : 'Could not load the coverage report');
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
 * One dimension of the crawl, as a share of itself.
 *
 * A total of zero renders as "none found" rather than 0%: a crawl that turned
 * up no forms is not a suite that fails to test them, and a dead-empty bar
 * saying 0% is the single most misread thing this screen could draw.
 */
function Dimension({ label, covered, total }: { label: string; covered: number; total: number }) {
  const pct = total === 0 ? null : Math.round((covered / total) * 100);
  return (
    <div>
      <p className="text-meta text-ink-faint mb-1.5 font-mono tracking-[0.08em] uppercase">
        {label}{' '}
        {pct === null ? (
          <span className="text-ink-faint">none found</span>
        ) : (
          <span className="text-ink tabular-nums">{pct}%</span>
        )}
      </p>
      <span className="bg-surface-2 block h-1 overflow-hidden rounded-full">
        {pct !== null && (
          <span className="bg-accent block h-full rounded-full" style={{ width: `${pct}%` }} />
        )}
      </span>
    </div>
  );
}

/**
 * The lead: the answer as a sentence, then the four ratios it is made of.
 *
 * The percentage is asserted-over-proven across every dimension the crawl
 * measured, which is the only honest way to state it — coverage here is against
 * what the application demonstrably does, not against lines of code, and the
 * sentence under the number says so because people assume otherwise.
 */
function CoverageHeadline({ report }: { report: CoverageReport }) {
  const t = report.totals;
  const proven = t.routes + t.journeys + t.forms + t.affordances;
  const asserted = t.routesVisited + t.journeysWalked + t.formsExercised + t.affordancesUsed;
  const pct = proven === 0 ? null : Math.round((asserted / proven) * 100);
  const unreadable = t.tests - t.testsWithReadableRoutes;

  return (
    <>
      <p className="font-display text-[28px] leading-[1.25] font-semibold">
        {pct === null ? (
          'The crawl proved nothing this report can measure against.'
        ) : (
          <>
            <span className="tabular-nums">{pct}%</span> of proven behaviour is asserted.
          </>
        )}
      </p>
      <p className="text-ink-dim text-body-sm mt-2">
        The crawler proved <span className="tabular-nums">{t.routes}</span> states and{' '}
        <span className="tabular-nums">{t.journeys + t.forms + t.affordances}</span> actions; the
        suite asserts <span className="tabular-nums">{asserted}</span> of them. Coverage is against
        what the app can do — not lines of code
        {report.flowMapVersion !== null && (
          <>
            {' '}
            (crawl v<span className="tabular-nums">{report.flowMapVersion}</span>
            {report.baseUrl && <> of {report.baseUrl}</>})
          </>
        )}
        .
      </p>

      {/*
       * ROUTES / JOURNEYS / FORMS / CONTROLS, not the reference's ROUTES /
       * FORMS / ROLES / A11Y: the coverage endpoint measures these four and
       * says nothing about roles or accessibility, and a bar with no number
       * behind it is worse than a bar that is missing.
       */}
      <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
        <Dimension label="Routes" covered={t.routesVisited} total={t.routes} />
        <Dimension label="Journeys" covered={t.journeysWalked} total={t.journeys} />
        <Dimension label="Forms" covered={t.formsExercised} total={t.forms} />
        <Dimension label="Controls" covered={t.affordancesUsed} total={t.affordances} />
      </div>

      {unreadable > 0 && (
        <p className="text-ink-dim text-row-sub mt-4">
          <span className="text-flake">Read this first:</span>{' '}
          <span className="tabular-nums">{unreadable}</span> of{' '}
          <span className="tabular-nums">{t.tests}</span> tests declare coverage this report could
          not read completely, so they are counted neither as coverage nor as a gap.
        </p>
      )}
    </>
  );
}

// ─── One gap ─────────────────────────────────────────────────────────────────

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-meta text-ink-faint mb-1 font-mono font-semibold tracking-[0.1em] uppercase">
        {label}
      </div>
      <div className="text-ink-dim text-body-sm">{children}</div>
    </div>
  );
}

function FormFields({
  fields,
}: {
  fields: Array<{ label: string; required: boolean; semantic: string }>;
}) {
  if (fields.length === 0) return <span className="text-ink-faint">no fields</span>;
  return (
    <ul className="space-y-1">
      {fields.map((f, i) => (
        <li key={`${f.label}-${i}`} className="flex items-center gap-2">
          <code className="text-ink text-body-sm font-mono">{f.label}</code>
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
          <code className="text-ink-dim text-micro font-mono">{form.name}</code>
          <div className="mt-0.5 pl-3">
            <FormFields fields={form.fields} />
          </div>
        </div>
      ))}
      {unique.length < forms.length && (
        <p className="text-ink-faint text-meta">
          {forms.length - unique.length} identical copy(s) on other pages sharing this route are not
          repeated here.
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
                  <li key={i} className="text-body-sm font-mono">
                    {a}
                  </li>
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
                  <span className="text-ink-faint text-meta w-4 shrink-0 tabular-nums">{i + 1}</span>
                  <code className="text-body-sm font-mono">{r}</code>
                  {s.steps[i] && <span className="text-ink-faint text-meta">via {s.steps[i]}</span>}
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
            <code className="text-body-sm font-mono">{s.form.name}</code>
            {s.behindAuth && (
              <Badge tone="flake" className="ml-2">
                behind auth
              </Badge>
            )}
          </KeyValue>
          <KeyValue label="Fields">
            <FormFields fields={s.form.fields} />
          </KeyValue>
          {s.form.submitLabel && (
            <KeyValue label="Submit control">
              <code className="text-body-sm font-mono">{s.form.submitLabel}</code>
            </KeyValue>
          )}
        </div>
      );
    case 'affordance':
      return (
        <div className="space-y-3">
          <KeyValue label={`The ${s.controlKind}`}>{s.label}</KeyValue>
          <KeyValue label="Locator the crawl recorded">
            <code className="text-ink bg-surface-2 text-body-sm block rounded-sm px-2 py-1.5 font-mono break-all">
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
                <code key={r} className="bg-surface-2 text-body-sm rounded-sm px-1.5 py-0.5 font-mono">
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

/**
 * The row's second line: why this is a gap, compressed to one line.
 *
 * Kind meaning first, then the report's own first piece of evidence. The claim
 * and at least some of its support travel together — a ranked list of untested
 * surfaces with the reasons one click away is a list that gets argued with once
 * and then ignored.
 */
function gapWhy(gap: CoverageGap): string {
  return [gap.route, KIND_MEANING[gap.kind], gap.evidence[0]].filter(Boolean).join(' · ');
}

function GapRow({
  gap,
  selected,
  onToggle,
  onPlan,
  planning,
  testNames,
}: {
  gap: CoverageGap;
  selected: boolean;
  onToggle: () => void;
  onPlan: () => void;
  planning: boolean;
  testNames: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const detailId = `gap-detail-${gap.id}`;

  return (
    <div className="border-line border-b">
      <div className="flex items-baseline gap-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="accent-accent mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer self-start"
          aria-label={`Select: ${gap.title}`}
        />
        <span className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailId}
            className="text-row hover:text-accent block text-left font-medium transition-colors"
          >
            {gap.title}
          </button>
          <span className="text-row-sub text-ink-faint mt-0.5 block">{gapWhy(gap)}</span>
        </span>
        <button
          type="button"
          onClick={onPlan}
          disabled={planning}
          className="text-accent shrink-0 text-[12px] hover:underline disabled:opacity-50"
        >
          {planning ? 'planning…' : 'plan a test →'}
        </button>
      </div>

      {open && (
        <div
          id={detailId}
          className="border-line bg-surface-1 mb-3 grid gap-6 rounded-lg border p-4 md:grid-cols-2"
        >
          <div className="space-y-4">
            <div>
              <SectionLabel>What the crawl saw</SectionLabel>
              <SubjectDetail gap={gap} />
            </div>

            <div>
              <SectionLabel>Why we think so</SectionLabel>
              <ul className="text-ink-dim text-body-sm space-y-1.5 leading-relaxed">
                {gap.evidence.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>

            <div>
              <SectionLabel>Ranked {gap.score} because</SectionLabel>
              <ul className="text-ink-dim text-body-sm space-y-1">
                {gap.scoreWhy.map((why, i) => (
                  <li key={i}>{why}</li>
                ))}
              </ul>
              <div className="text-ink-faint text-meta mt-2 flex gap-4 font-mono tabular-nums">
                <span>reachability {Math.round(gap.reachability * 100)}%</span>
                <span>blast radius {Math.round(gap.blastRadius * 100)}%</span>
                <span>{gap.confidence} confidence</span>
              </div>
            </div>

            {gap.relatedTestIds.length > 0 && (
              <div>
                <SectionLabel>Nearby, but does not close it</SectionLabel>
                <ul className="text-ink-dim text-body-sm space-y-0.5">
                  {gap.relatedTestIds.map((id) => (
                    <li key={id} className="truncate">
                      {testNames.get(id) ?? <code className="text-micro font-mono">{id}</code>}
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
                  <div className="text-meta text-ink-faint mb-1 font-mono font-semibold tracking-[0.1em] uppercase">
                    Steps
                  </div>
                  <ol className="text-ink-dim text-body-sm list-inside list-decimal space-y-1">
                    {gap.proposal.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <div className="text-meta text-ink-faint mb-1 font-mono font-semibold tracking-[0.1em] uppercase">
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
    </div>
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
      <ul className="divide-line mb-4 divide-y">
        {result.items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-2.5">
            <span className="text-ink text-row min-w-0 flex-1 truncate">{item.title}</span>
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
              (job <code className="text-micro font-mono">{result.jobId}</code>)
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
          {result.skippedGapIds.length === 1 ? 'gap was' : 'gaps were'} no longer in the report and{' '}
          {result.skippedGapIds.length === 1 ? 'was' : 'were'} skipped.
        </p>
      )}
    </Modal>
  );
}

// ─── The screen ──────────────────────────────────────────────────────────────

function CoverageSkeleton() {
  return (
    <div>
      <Skeleton className="h-8 w-[26rem] max-w-full" />
      <Skeleton className="mt-3 h-3 w-full max-w-lg" />
      <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="mb-1.5 h-2.5 w-20" />
            <Skeleton className="h-1 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-8 h-2.5 w-28" />
      <div className="divide-line mt-2 divide-y" aria-label="Loading" role="status">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="py-3">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="mt-2 h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

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
  /** The single gap a `plan a test →` click is in flight for, so only its row spins. */
  const [planningId, setPlanningId] = useState<string | null>(null);
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

  /**
   * Turn gaps into plan items.
   *
   * One code path for the row link and the bulk bar, because they are the same
   * request with a different number of ids — and because the 409 handling below
   * (the report moved under you) has to be identical either way.
   */
  async function propose(gapIds: string[]) {
    if (!projectId || !report || gapIds.length === 0) return;
    try {
      const proposal = await api<CoverageProposeResult>(`/coverage/${projectId}/propose`, {
        method: 'POST',
        body: JSON.stringify({
          gapIds,
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
    }
  }

  async function proposeSelected() {
    setProposing(true);
    try {
      await propose([...selected]);
    } finally {
      setProposing(false);
    }
  }

  async function proposeOne(gapId: string) {
    setPlanningId(gapId);
    try {
      await propose([gapId]);
    } finally {
      setPlanningId(null);
    }
  }

  if (loading) return <CoverageSkeleton />;

  if (error) {
    return (
      <p
        role="alert"
        className="border-fail/40 text-fail text-body-sm rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] p-3"
      >
        {error}
      </p>
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
        <div className="border-flake/40 mt-6 rounded-md border bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)] p-3">
          <div className="text-flake text-meta mb-1.5 font-mono font-semibold tracking-[0.1em] uppercase">
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
        <p className="text-ink-dim text-row-sub mt-4">
          {report.unreadable.length} part(s) of the flow map could not be read:{' '}
          {report.unreadable.join('; ')}
        </p>
      )}

      {report.gaps.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="Every surface the crawl found is exercised"
            body={`Crawl v${report.flowMapVersion ?? '?'} found ${report.totals.routes} route(s), ${report.totals.journeys} journey(s), ${report.totals.forms} form(s) and ${report.totals.affordances} control(s), and a test touches all of them. New gaps appear when the app grows or the Explorer runs again.`}
            action={{ label: 'Re-crawl the app', href: '/flow-map' }}
          />
        </div>
      ) : (
        <section className="mt-8">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <SectionLabel className="mb-0">Ranked gaps · {report.totals.gaps}</SectionLabel>
            {/* Filters. Client-side over the report already in hand, so the
                fingerprint the selection was made against never moves. */}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setKinds(new Set())}
                aria-pressed={kinds.size === 0}
                className={cn(
                  'text-meta rounded-full border px-2 py-0.5 font-mono transition-colors',
                  kinds.size === 0
                    ? 'border-accent text-accent'
                    : 'border-line text-ink-faint hover:text-ink',
                )}
              >
                ALL <span className="tabular-nums">{report.gaps.length}</span>
              </button>
              {[...kindCounts.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([kind, count]) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={kinds.has(kind)}
                    onClick={() =>
                      setKinds((prev) => {
                        const next = new Set(prev);
                        if (next.has(kind)) next.delete(kind);
                        else next.add(kind);
                        return next;
                      })
                    }
                    className={cn(
                      'text-meta rounded-full border px-2 py-0.5 font-mono transition-colors',
                      kinds.has(kind)
                        ? 'border-accent text-accent'
                        : 'border-line text-ink-faint hover:text-ink',
                    )}
                  >
                    {KIND_LABEL[kind]} <span className="tabular-nums">{count}</span>
                  </button>
                ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set(visible.slice(0, maxPropose).map((g) => g.id)))}
              >
                Select top {Math.min(visible.length, maxPropose)}
              </Button>
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="text-ink-faint text-body-sm py-6">
              No gap of that kind. Clear the filter to see the other{' '}
              <span className="tabular-nums">{report.gaps.length}</span>.
            </p>
          ) : (
            <div>
              {visible.map((gap) => (
                <GapRow
                  key={gap.id}
                  gap={gap}
                  selected={selected.has(gap.id)}
                  onToggle={() => toggle(gap.id)}
                  onPlan={() => void proposeOne(gap.id)}
                  planning={planningId === gap.id}
                  testNames={testNames}
                />
              ))}
            </div>
          )}

          {report.unknowns.length > 0 && (
            <div className="mt-8">
              <SectionLabel>
                {report.unknowns.length} test(s) whose coverage could not be read
              </SectionLabel>
              <p className="text-ink-dim text-row-sub mb-2">
                Neither a gap nor coverage — the third state. Read the count above knowing these
                were not counted either way.
              </p>
              <div>
                {report.unknowns.map((u) => (
                  <div key={u.testId} className="border-line border-b py-3">
                    <div className="text-ink text-row">{u.name}</div>
                    <div className="text-ink-faint text-meta font-mono">{u.filePath}</div>
                    <div className="text-ink-dim text-row-sub mt-1">{u.reason}</div>
                    {u.sample && (
                      <code className="bg-surface-2 text-ink-dim text-meta mt-1 block rounded-sm px-2 py-1 font-mono break-all">
                        {u.sample}
                      </code>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {selected.size > 0 && (
            <div className="sticky bottom-6 z-20 mt-6">
              <div className="border-line-strong bg-surface-1 shadow-overlay flex items-center gap-4 rounded-lg border p-3">
                <span className="text-row">
                  <span className="font-medium tabular-nums">{selected.size}</span> gap
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
                    onClick={() => void proposeSelected()}
                  >
                    Propose {selected.size} test{selected.size === 1 ? '' : 's'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {result && projectId && (
        <ProposeResult result={result} projectId={projectId} onClose={() => setResult(null)} />
      )}
    </>
  );
}
