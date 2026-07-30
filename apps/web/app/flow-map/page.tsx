'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project } from '../../lib/api';

/**
 * The flow map (§3.1) — what QAAI found when it crawled your app.
 *
 * This is the "it actually understands my app" moment, and it has never had a
 * screen: the crawl wrote a graph, the planner read it, and the user saw
 * neither. Rendered as a route list rather than a force-directed graph on
 * purpose — a QA engineer wants to answer "did it reach checkout, and what did
 * it find there", which a tidy list answers faster than a hairball of nodes.
 */

interface Selector {
  strategy: string;
  value: string;
  name?: string;
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
  forms?: Array<{ fields?: unknown[] }>;
}

interface FlowMap {
  version: number;
  baseUrl: string;
  nodes: FlowNode[];
  edges: Array<{ from: string; to: string }>;
  journeys: Array<{ id: string; name: string; nodeIds: string[] }>;
  truncatedReason: string | null;
}

export default function FlowMapPage() {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [flowMap, setFlowMap] = useState<FlowMap | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>('/projects');
        const first = projects[0];
        if (!first) {
          setLoading(false);
          return;
        }
        setProject(first);
        const { flowMap } = await api<{ flowMap: { graph: FlowMap } }>(
          `/projects/${first.id}/flow-map`,
        )
          .then((d) => ({ flowMap: d.flowMap.graph }))
          .catch(() => ({ flowMap: null as unknown as FlowMap }));
        setFlowMap(flowMap);
        setSelected(flowMap?.nodes[0]?.id ?? null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the flow map');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const node = useMemo(
    () => flowMap?.nodes.find((n) => n.id === selected) ?? null,
    [flowMap, selected],
  );

  if (loading) {
    return <main className="text-ink-faint p-10 text-sm">Loading the map…</main>;
  }

  if (!flowMap) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">No map yet</h1>
        <p className="text-ink-dim mt-2 text-sm">
          {project
            ? 'QAAI builds this when it crawls your app. Start a crawl from Add app.'
            : 'Add an app first — QAAI maps it while it crawls.'}
        </p>
        <a
          href="/onboarding"
          className="bg-accent mt-6 inline-block rounded-md px-4 py-2 text-sm font-medium text-white"
        >
          Add an app
        </a>
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col">
      <header className="border-line flex shrink-0 items-baseline gap-3 border-b px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">Flow map</h1>
        <span className="text-ink-faint text-xs">
          v{flowMap.version} · {flowMap.nodes.length} pages · {flowMap.edges.length} links ·{' '}
          <span className="font-mono">{flowMap.baseUrl}</span>
        </span>
      </header>

      {error && (
        <p className="border-fail/40 bg-fail/10 text-fail mx-6 mt-4 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}
      {flowMap.truncatedReason && (
        <p className="border-flake/40 bg-flake/10 text-flake mx-6 mt-4 rounded-md border p-3 text-xs">
          The crawl stopped early: {flowMap.truncatedReason}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr]">
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          {flowMap.nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSelected(n.id)}
              className={`border-line/60 flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left ${
                selected === n.id ? 'bg-surface-2' : 'hover:bg-surface-1'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-micro">{n.route}</span>
                {n.behindAuth && (
                  <span className="text-flake shrink-0 text-meta" title="Behind a login">
                    🔒
                  </span>
                )}
                {n.a11yViolationCount > 0 && (
                  <span className="text-fail shrink-0 text-meta">
                    {n.a11yViolationCount} a11y
                  </span>
                )}
              </div>
              <span className="text-ink-faint truncate text-micro">{n.title}</span>
              <span className="text-ink-faint text-meta">
                {n.affordances.length} element(s)
              </span>
            </button>
          ))}
        </aside>

        <section className="min-h-0 overflow-y-auto px-6 py-5">
          {node ? (
            <>
              <div className="mb-5">
                <h2 className="font-mono text-lg">{node.route}</h2>
                <p className="text-ink-dim mt-1 text-sm">{node.title}</p>
                <p className="text-ink-faint mt-1 font-mono text-micro">{node.url}</p>
                {node.behindAuth && (
                  <p className="text-flake mt-2 text-xs">
                    Behind a login wall
                    {node.requiresRoles.length > 0 && ` — needs ${node.requiresRoles.join(', ')}`}
                  </p>
                )}
              </div>

              <h3 className="text-ink-dim mb-2 text-xs font-semibold tracking-wider uppercase">
                What QAAI can interact with
              </h3>
              <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
                {node.affordances.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2">
                    <span className="border-line text-ink-faint shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase">
                      {a.kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-body-sm">{a.label}</span>
                    <span className="text-ink-faint shrink-0 font-mono text-meta">
                      {a.selector.strategy}
                    </span>
                    <span
                      className={`shrink-0 font-mono text-meta ${
                        a.selector.confidence >= 0.8
                          ? 'text-pass'
                          : a.selector.confidence >= 0.6
                            ? 'text-flake'
                            : 'text-fail'
                      }`}
                      title="How stable this locator is"
                    >
                      {Math.round(a.selector.confidence * 100)}%
                    </span>
                  </div>
                ))}
                {node.affordances.length === 0 && (
                  <p className="text-ink-faint px-4 py-4 text-center text-xs">
                    Nothing interactive was found here.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="text-ink-faint text-sm">Select a page.</p>
          )}
        </section>
      </div>
    </main>
  );
}
