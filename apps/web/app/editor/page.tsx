'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project, type Run } from '../../lib/api';
import { CodeEditor } from '../../components/CodeEditor';
import { AgentPanel } from '../../components/AgentPanel';
import { RecordButton } from '../../components/RecordButton';
import { StatusDot, duration } from '../../components/ui';

/**
 * The editor (§8) — write and run tests by hand.
 *
 * Three panes, like the cockpit: file tree, Monaco, results. The point is that
 * a QA engineer who already knows what to write should not have to negotiate
 * with an agent to get it written. Save with Cmd-S, run with Cmd-Enter, and the
 * result lands in the right pane without leaving the page.
 */

interface TestSummary {
  id: string;
  name: string;
  type: string;
  feature: string | null;
  priority: string;
  filePath: string;
  reviewFlags: string[];
  quarantined: boolean;
}

interface FullTest extends TestSummary {
  code: string;
  spec: unknown;
}

/** Non-Playwright plugins are configured with JSON, not source. */
const SPEC_DRIVEN = new Set(['API', 'ACCESSIBILITY', 'SECURITY_SMOKE', 'VISUAL', 'LOAD']);

const NEW_TEST_TEMPLATE = `import { test, expect } from '@playwright/test';

test('describe what must be true', async ({ page }) => {
  await test.step('Set up the state under test', async () => {
    await page.goto('/');
  });

  await test.step('Assert something that could actually be wrong', async () => {
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
`;

export default function EditorPage() {
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [tests, setTests] = useState<TestSummary[]>([]);
  const [openTest, setOpenTest] = useState<FullTest | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);

  const loadTests = useCallback(async (projectId: string) => {
    const { tests } = await api<{ tests: TestSummary[] }>(`/projects/${projectId}/tests`);
    setTests(tests);
    return tests;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>('/projects');
        const first = projects[0];
        if (!first) {
          setError('No projects yet — run the seed.');
          return;
        }
        setProject(first);
        const loaded = await loadTests(first.id);
        if (loaded[0]) void openFile(first.id, loaded[0].id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load the editor');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  async function openFile(projectId: string, testId: string) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const { test } = await api<{ test: FullTest }>(`/projects/${projectId}/tests/${testId}`);
    setOpenTest(test);
    setDraft(SPEC_DRIVEN.has(test.type) ? JSON.stringify(test.spec ?? {}, null, 2) : test.code);
    setDirty(false);
    setStatus(null);
  }

  const save = useCallback(async () => {
    if (!project || !openTest || saving) return;
    setSaving(true);
    setStatus(null);
    try {
      const isSpec = SPEC_DRIVEN.has(openTest.type);
      // A spec-driven test stores JSON; refuse to save something unparseable
      // rather than let the runner discover it at execution time.
      if (isSpec) {
        try {
          JSON.parse(draft);
        } catch {
          setStatus('Not valid JSON — fix it before saving');
          return;
        }
      }

      await api(`/projects/${project.id}/tests/${openTest.id}`, {
        method: 'PUT',
        body: JSON.stringify(
          isSpec ? { code: openTest.code, spec: JSON.parse(draft) } : { code: draft },
        ),
      });

      setDirty(false);
      setStatus('Saved');
      await loadTests(project.id);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [project, openTest, draft, saving, loadTests]);

  const runThis = useCallback(async () => {
    if (!project || !openTest || running) return;
    const environmentId = project.environments[0]?.id;
    if (!environmentId) {
      setStatus('This project has no environment to run against');
      return;
    }

    setRunning(true);
    setStatus('Running…');
    try {
      if (dirty) await save();

      const { run } = await api<{ run: Run }>('/runs', {
        method: 'POST',
        body: JSON.stringify({ environmentId, testIds: [openTest.id], trigger: 'MANUAL' }),
      });

      // Poll rather than open an SSE stream: a single test finishes in seconds
      // and a stream would be more machinery than the wait deserves.
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { run: latest } = await api<{ run: Run }>(`/runs/${run.id}`);
        setLastRun(latest);
        if (['PASSED', 'FAILED', 'ERRORED', 'CANCELLED'].includes(latest.status)) break;
      }
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  }, [project, openTest, dirty, running, save]);

  // Cmd-Enter runs. Cmd-S is bound inside Monaco so it only fires with the
  // editor focused; run is useful from anywhere on the page.
  const runRef = useRef(runThis);
  runRef.current = runThis;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void runRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Warn on tab close with unsaved work — Monaco holds the only copy.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  async function createTest() {
    if (!project) return;
    const name = prompt('Test name', 'New test');
    if (!name) return;

    try {
      const { test } = await api<{ test: FullTest }>(`/projects/${project.id}/tests`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          type: 'E2E',
          feature: 'Hand-written',
          priority: 'IMPORTANT',
          code: NEW_TEST_TEMPLATE,
          filePath: `hand-written/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.spec.ts`,
          tags: [],
        }),
      });
      await loadTests(project.id);
      await openFile(project.id, test.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the test');
    }
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, TestSummary[]>();
    for (const test of tests) {
      const key = test.feature ?? 'Uncategorised';
      groups.set(key, [...(groups.get(key) ?? []), test]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tests]);

  const result = lastRun?.results?.[0] ?? null;

  if (error) {
    return (
      <main className="p-10">
        <p className="text-fail">{error}</p>
        <Link href="/runs" className="text-accent mt-4 inline-block text-sm">
          Back to runs
        </Link>
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="app-drag border-line flex shrink-0 items-center gap-4 border-b px-5 py-3">
        <Link href="/runs" className="text-sm font-semibold tracking-tight">
          QAAI
        </Link>
        <span className="text-ink-dim text-sm">Editor</span>
        {openTest && (
          <span className="text-ink-faint font-mono text-xs">
            {openTest.filePath}
            {dirty && <span className="text-flake"> ●</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {status && <span className="text-ink-faint text-xs">{status}</span>}
          <RecordButton
            projectId={project?.id ?? ''}
            environmentId={project?.environments[0]?.id ?? null}
            onRecorded={(testId) => {
              if (project) {
                void loadTests(project.id).then(() => void openFile(project.id, testId));
              }
            }}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs disabled:opacity-40"
          >
            Save <span className="text-ink-faint">⌘S</span>
          </button>
          <button
            type="button"
            onClick={() => void runThis()}
            disabled={running || !openTest}
            className="bg-accent rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            {running ? 'Running…' : 'Run'} <span className="opacity-70">⌘↵</span>
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr_400px]">
        {/* ── File tree ───────────────────────────────────────────────────── */}
        <aside className="border-line min-h-0 overflow-y-auto border-r">
          <div className="border-line flex items-center justify-between border-b px-3 py-2">
            <span className="text-ink-faint text-[11px] font-semibold tracking-wider uppercase">
              {project?.name ?? 'Tests'}
            </span>
            <button
              type="button"
              onClick={() => void createTest()}
              title="New test"
              className="text-ink-faint hover:text-ink px-1 text-sm"
            >
              +
            </button>
          </div>

          {grouped.map(([feature, items]) => (
            <div key={feature}>
              <p className="text-ink-faint px-3 pt-3 pb-1 font-mono text-[10px] tracking-wider uppercase">
                {feature}
              </p>
              {items.map((test) => (
                <button
                  key={test.id}
                  type="button"
                  onClick={() => project && void openFile(project.id, test.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                    openTest?.id === test.id ? 'bg-surface-2' : 'hover:bg-surface-1'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{test.name}</span>
                  {test.reviewFlags.length > 0 && (
                    <span
                      className="text-flake text-[10px]"
                      title="Generator flagged this for review"
                    >
                      ⚑
                    </span>
                  )}
                  <span className="text-ink-faint font-mono text-[9px]">{test.type}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* ── Monaco ──────────────────────────────────────────────────────── */}
        <section className="min-h-0">
          {openTest ? (
            <CodeEditor
              value={draft}
              language={SPEC_DRIVEN.has(openTest.type) ? 'json' : 'typescript'}
              onChange={(next) => {
                setDraft(next);
                setDirty(true);
              }}
              onSave={() => void save()}
            />
          ) : (
            <p className="text-ink-faint p-6 text-sm">
              Select a test, or press + to write a new one.
            </p>
          )}
        </section>

        {/* ── Agent + result ─────────────────────────────────────────────── */}
        <aside className="border-line grid min-h-0 grid-rows-[1fr_auto] border-l">
          <div className="min-h-0">
            <AgentPanel
              projectId={project?.id ?? ''}
              onApplied={() => {
                if (project) {
                  void loadTests(project.id);
                  if (openTest) void openFile(project.id, openTest.id);
                }
              }}
            />
          </div>

          <div className="border-line max-h-[45%] overflow-y-auto border-t px-3 py-3">
            {openTest?.reviewFlags.length ? (
              <div className="border-flake/40 bg-flake/10 mb-4 rounded-md border p-3">
                <p className="text-flake mb-1.5 text-[11px] font-semibold tracking-wider uppercase">
                  Generator flagged
                </p>
                <ul className="text-ink-dim space-y-1 text-xs">
                  {openTest.reviewFlags.map((flag, i) => (
                    <li key={i}>{flag}</li>
                  ))}
                </ul>
                <p className="text-ink-faint mt-2 text-[11px]">Saving clears these.</p>
              </div>
            ) : null}

            {result ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <StatusDot status={result.status} />
                  <span className="text-sm">{result.status}</span>
                  <span className="text-ink-faint ml-auto font-mono text-xs">
                    {duration(result.durationMs)}
                  </span>
                </div>

                <ol className="space-y-1">
                  {result.steps.map((s) => (
                    <li
                      key={s.id}
                      className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                        s.status === 'FAILED' ? 'border-fail/40 bg-fail/5' : 'border-line'
                      }`}
                    >
                      <StatusDot status={s.status} />
                      <span className="flex-1 truncate">{s.title}</span>
                      <span className="text-ink-faint font-mono text-[10px]">
                        {duration(s.durationMs)}
                      </span>
                    </li>
                  ))}
                </ol>

                {(result.errorMessage || result.steps.some((s) => s.errorMessage)) && (
                  <pre className="border-fail/40 bg-fail/5 text-fail mt-3 overflow-x-auto rounded-md border p-2.5 font-mono text-[11px] whitespace-pre-wrap">
                    {result.errorMessage ?? result.steps.find((s) => s.errorMessage)?.errorMessage}
                  </pre>
                )}

                {lastRun && (
                  <Link
                    href={`/runs/${lastRun.id}`}
                    className="text-accent mt-3 inline-block text-xs"
                  >
                    Open in cockpit →
                  </Link>
                )}
              </>
            ) : (
              <p className="text-ink-faint text-xs">
                Press <span className="font-mono">⌘↵</span> to run this test. The result lands here.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
