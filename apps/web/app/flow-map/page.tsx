'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { TestsHeader } from '../../components/TestsHeader';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page, Skeleton } from '../../components/ui/layout';
import { cn } from '../../lib/cn';

/**
 * The flow map (§3.1) — what QAAI found when it crawled your app.
 *
 * This is the "it actually understands my app" moment, and it went years
 * without a screen: the crawl wrote a graph, the planner read it, and the user
 * saw neither. Rendered as a route list rather than a force-directed graph on
 * purpose — a QA engineer wants to answer "did it reach checkout, and what did
 * it find there", which a tidy list answers faster than a hairball of nodes.
 *
 * The right pane leads with where a state sits in the graph, because a state
 * with nothing leading into it is a state no test can reach, and that is the
 * most useful thing this screen can tell you.
 */

interface Selector {
  strategy: string;
  value: string;
  name?: string;
  nth?: number;
  confidence: number;
}

interface FlowNode {
  id: string;
  route: string;
  url: string;
  title: string;
  behindAuth: boolean;
  requiresRoles: string[];
  a11yViolationCount: number;
  affordances: Array<{ label: string; selector: Selector; kind: string }>;
  forms?: Array<{ id: string; name: string; fields?: Array<{ required?: boolean }> }>;
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
  action: string;
}

interface FlowGraph {
  version: number;
  baseUrl: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Journeys are paths through the EDGES, not the nodes — see @qaai/shared. */
  journeys: Array<{ id: string; name: string; edgeIds: string[] }>;
  truncatedReason: string | null;
}

/** The stored row around the graph — where the crawl's own metadata lives. */
interface FlowMapRow {
  graph: FlowGraph;
  version: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  truncatedReason: string | null;
}

/** A confidence at or above this is one the generator will not flag. */
const STABLE = 0.8;

/**
 * The Playwright call a human would write for a crawled selector.
 *
 * Kept in sync with `locatorExpression` in @qaai/shared. Duplicated as a plain
 * function rather than imported, the way this app already duplicates the
 * shared constants it needs: nothing in `apps/web` pulls from that package at
 * runtime, and a locator string is not worth being the first thing that does.
 */
function locatorExpression(selector: Selector): string {
  const q = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const { strategy, value, name, nth } = selector;

  let call: string;
  switch (strategy) {
    case 'ROLE':
      call = name ? `getByRole(${q(value)}, { name: ${q(name)} })` : `getByRole(${q(value)})`;
      break;
    case 'LABEL':
      call = `getByLabel(${q(name ?? value)})`;
      break;
    case 'PLACEHOLDER':
      call = `getByPlaceholder(${q(name ?? value)})`;
      break;
    case 'TEXT':
      call = `getByText(${q(name ?? value)})`;
      break;
    case 'TEST_ID':
      call = `getByTestId(${q(value)})`;
      break;
    default:
      call = `locator(${q(value)})`;
      break;
  }
  return nth === undefined ? call : `${call}.nth(${nth})`;
}

export default function FlowMapPage() {
  const router = useRouter();
  /**
   * The map belongs to a project, and the project is the shell's choice now —
   * this screen used to render `projects[0]`'s crawl with nothing on the page
   * saying whose app it was.
   */
  const { project, projectId, loading: projectsLoading } = useProject();
  const [map, setMap] = useState<FlowMapRow | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recrawling, setRecrawling] = useState(false);
  const [recrawlNote, setRecrawlNote] = useState<string | null>(null);

  useEffect(() => {
    // Wait for the shell to settle before concluding there is no project —
    // otherwise the first paint claims "no map" for everyone.
    if (projectsLoading) return;
    if (!projectId) {
      setMap(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const row = await api<{ flowMap: FlowMapRow }>(`/projects/${projectId}/flow-map`)
          .then((d) => d.flowMap)
          .catch((err) => {
            // A project that has never been crawled has no map, and that is the
            // "No map yet" screen rather than an error. Signed out is not.
            if (err instanceof ApiError && err.status === 401) throw err;
            return null;
          });
        if (cancelled) return;
        setMap(row);
        setSelected(row?.graph.nodes[0]?.id ?? null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the flow map');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, projectsLoading, router]);

  const graph = map?.graph ?? null;
  const node = useMemo(
    () => graph?.nodes.find((n) => n.id === selected) ?? null,
    [graph, selected],
  );

  /** Routes in, routes out, and the journeys this state sits on. */
  const context = useMemo(() => {
    if (!graph || !node) return { from: [] as string[], to: [] as string[], journeys: [] as string[] };
    const route = (id: string) => graph.nodes.find((n) => n.id === id)?.route ?? null;
    const from = [
      ...new Set(graph.edges.filter((e) => e.to === node.id).map((e) => route(e.from))),
    ].filter((r): r is string => Boolean(r));
    const to = [
      ...new Set(graph.edges.filter((e) => e.from === node.id).map((e) => route(e.to))),
    ].filter((r): r is string => Boolean(r));

    const touching = new Set(
      graph.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => e.id),
    );
    const journeys = graph.journeys
      .filter((j) => j.edgeIds.some((id) => touching.has(id)))
      .map((j) => j.name);

    return { from, to, journeys };
  }, [graph, node]);

  /**
   * Re-crawl. The Explorer needs no model — it drives a real browser — so this
   * is offered even on a deployment with no API key configured.
   */
  const recrawl = useCallback(async () => {
    const environmentId = project?.environments[0]?.id;
    if (!project || !environmentId || recrawling) {
      if (!environmentId) setRecrawlNote('This app has no environment to crawl. Add one in Setup.');
      return;
    }
    setRecrawling(true);
    setRecrawlNote(null);
    try {
      await api(`/projects/${project.id}/explore`, {
        method: 'POST',
        body: JSON.stringify({ environmentId, maxPages: 25, maxDepth: 3 }),
      });
      setRecrawlNote('Crawling. This map updates when the Explorer finishes — reload to see it.');
    } catch (err) {
      setRecrawlNote(err instanceof Error ? err.message : 'Could not start the crawl');
    } finally {
      setRecrawling(false);
    }
  }, [project, recrawling]);

  if (loading) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,320px)_minmax(300px,1fr)]">
          <aside className="border-line space-y-1.5 border-r px-3.5 py-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </aside>
          <section className="space-y-3 px-7 py-[22px]">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-80" />
            <Skeleton className="mt-6 h-40 w-full" />
          </section>
        </div>
      </Page>
    );
  }

  if (error) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
          <p className="text-fail text-body-sm">{error}</p>
          <Link href="/runs" className="text-accent text-body-sm mt-4 inline-block">
            Back to runs
          </Link>
        </div>
      </Page>
    );
  }

  if (!graph || !map) {
    return (
      <Page width="full">
        <TestsHeader />
        <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
          <EmptyState
            title="No map yet"
            body={
              project
                ? 'QAAI builds this while it crawls your app: every state it reached, everything it can interact with, and how the two connect. Start a crawl and it fills in.'
                : 'Add an app first — QAAI maps it while it crawls.'
            }
            action={
              project
                ? { label: recrawling ? 'Starting…' : 'Crawl this app', onClick: () => void recrawl() }
                : { label: 'Add an app', href: '/onboarding' }
            }
          />
          {recrawlNote && <p className="text-ink-dim text-body-sm mt-4">{recrawlNote}</p>}
        </div>
      </Page>
    );
  }

  return (
    <Page width="full">
      <TestsHeader />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,320px)_minmax(300px,1fr)] overflow-x-auto">
        <aside className="border-line min-h-0 overflow-y-auto border-r px-3.5 py-4">
          <p className="text-ink-faint mb-2.5 font-mono text-[10.5px] leading-relaxed">
            crawled {relativeTime(map.createdAt)} · {map.nodeCount} states · {map.edgeCount} edges ·
            map v{map.version} ·{' '}
            <button
              type="button"
              onClick={() => void recrawl()}
              disabled={recrawling}
              className="text-accent hover:underline disabled:opacity-60"
            >
              {recrawling ? 'starting…' : 're-crawl'}
            </button>
          </p>
          {recrawlNote && (
            <p className="text-flake mb-2.5 text-[11px] leading-relaxed">{recrawlNote}</p>
          )}
          {graph.truncatedReason && (
            <p className="text-flake mb-2.5 text-[11px] leading-relaxed">
              The crawl stopped early: {graph.truncatedReason}
            </p>
          )}

          <div className="flex flex-col gap-0.5">
            {graph.nodes.map((n) => {
              const active = selected === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelected(n.id)}
                  aria-current={active ? 'true' : undefined}
                  title={n.title || n.route}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-[7px] text-left transition-colors',
                    active ? 'bg-surface-2 text-ink' : 'text-ink-dim hover:bg-surface-1',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{n.route}</span>
                  {n.a11yViolationCount > 0 ? (
                    <span className="text-fail shrink-0 font-mono text-[10px] tabular-nums">
                      a11y {n.a11yViolationCount}
                    </span>
                  ) : n.behindAuth ? (
                    <span className="text-flake shrink-0 font-mono text-[10px]">auth</span>
                  ) : (
                    <span className="text-ink-faint max-w-[45%] shrink-0 truncate text-[11px]">
                      {n.title}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto px-7 py-[22px]">
          {/* Capped: an affordance row is a label, a locator and a 70px bar, and
              on a wide monitor an uncapped column puts a metre of empty space
              between the three things you are meant to read together. */}
          <div className="max-w-[820px]">
            {node ? (
              <StateDetail node={node} context={context} />
            ) : (
              <p className="text-ink-faint text-body-sm">Select a state.</p>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}

function StateDetail({
  node,
  context,
}: {
  node: FlowNode;
  context: { from: string[]; to: string[]; journeys: string[] };
}) {
  const forms = node.forms ?? [];

  return (
    <>
      <p className="text-meta text-ink-faint font-mono tracking-[0.08em] uppercase">
        State · <span className="text-ink-dim normal-case">{node.url}</span>
      </p>
      <h2 className="font-display mt-2 text-[21px] leading-tight font-semibold">
        {node.title || node.route}
      </h2>
      <p className="text-ink-faint mt-1.5 text-[12.5px] leading-relaxed">
        {context.from.length > 0 ? (
          <>reached from {context.from.slice(0, 3).join(', ')}</>
        ) : (
          // Worth saying plainly: an unreachable state is one no generated test
          // can walk to, which is a finding rather than a blank.
          <>nothing in the crawl leads here</>
        )}
        {context.to.length > 0 && <> · leads to {context.to.slice(0, 3).join(', ')}</>}
        {context.journeys.length > 0 && (
          <>
            {' '}
            · on journeys{' '}
            {context.journeys.slice(0, 2).map((name, i) => (
              <span key={name} className="text-ink-dim">
                {i > 0 && ', '}
                {name}
              </span>
            ))}
            {context.journeys.length > 2 && ` +${context.journeys.length - 2}`}
          </>
        )}
        {node.behindAuth && (
          <>
            {' '}
            · <span className="text-flake">behind a login</span>
            {node.requiresRoles.length > 0 && ` — needs ${node.requiresRoles.join(', ')}`}
          </>
        )}
      </p>

      <section className="mt-6">
        <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
          Affordances · {node.affordances.length}
        </h3>
        {node.affordances.length === 0 ? (
          <p className="text-ink-faint mt-1.5 text-[13px]">
            Nothing interactive was found here, so nothing on this state can be driven by a test.
          </p>
        ) : (
          <>
            <div className="mt-1.5">
              {node.affordances.map((affordance, i) => {
                const confidence = affordance.selector.confidence;
                const stable = confidence >= STABLE;
                return (
                  <div
                    key={`${affordance.label}-${i}`}
                    className="border-line flex items-center gap-3 border-b py-[9px]"
                  >
                    <span className="w-[150px] shrink-0 truncate text-[13px]">
                      {affordance.label}
                    </span>
                    <span className="text-ink-dim min-w-0 flex-1 truncate font-mono text-[11px]">
                      {locatorExpression(affordance.selector)}
                    </span>
                    <span
                      className="bg-surface-2 h-1 w-[70px] shrink-0 overflow-hidden rounded-sm"
                      aria-hidden
                    >
                      <span
                        className={cn('block h-full', stable ? 'bg-pass' : 'bg-flake')}
                        style={{ width: `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%` }}
                      />
                    </span>
                    <span
                      className={cn(
                        'w-8 shrink-0 text-right font-mono text-[10.5px] tabular-nums',
                        stable ? 'text-ink-faint' : 'text-flake',
                      )}
                      title="How stable this locator is"
                    >
                      {confidence.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-ink-faint mt-2 font-mono text-[10.5px]">
              low-confidence locators come back as review flags when a test is generated
            </p>
          </>
        )}
      </section>

      <section className="mt-6">
        <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
          Forms · {forms.length}
        </h3>
        {forms.length === 0 ? (
          <p className="text-ink-faint mt-1.5 text-[13px]">No form on this state.</p>
        ) : (
          <p className="text-ink-dim mt-1.5 text-[13px] leading-relaxed">
            {forms.map((form, i) => {
              const fields = form.fields ?? [];
              const required = fields.filter((f) => f.required).length;
              return (
                <span key={form.id ?? i}>
                  {i > 0 && ' · '}
                  {form.name} — {fields.length} field{fields.length === 1 ? '' : 's'}
                  {required > 0 && (
                    <span className="text-ink-faint">
                      , {required} required
                    </span>
                  )}
                </span>
              );
            })}
          </p>
        )}
      </section>

      <section className="mt-6">
        <h3 className="text-meta text-ink-faint font-mono font-semibold tracking-[0.1em] uppercase">
          Accessibility
        </h3>
        <p className="text-ink-dim mt-1.5 text-[13px]">
          {node.a11yViolationCount > 0 ? (
            <>
              <span className="text-fail tabular-nums">
                {node.a11yViolationCount} finding{node.a11yViolationCount === 1 ? '' : 's'}
              </span>{' '}
              on this state —{' '}
              <Link href="/quality" className="text-accent text-[12.5px] hover:underline">
                in quality →
              </Link>
            </>
          ) : (
            <>The crawl found no axe violation on this state.</>
          )}
        </p>
      </section>
    </>
  );
}
