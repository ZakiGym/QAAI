'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, type Project } from '../../lib/api';

/**
 * Quality — findings and the flake radar, on one screen.
 *
 * They belong together because they answer the same question from two sides:
 * "what is wrong with the app" and "what is wrong with the tests". Both were
 * fully recorded and completely invisible — findings only ever appeared inside
 * a single test result, and flakeRate was maintained on every run and never
 * shown, so "which tests can I not trust" had no answer at all.
 */

interface Finding {
  id: string;
  kind: string;
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
  code: string;
  message: string;
  location: string;
  helpUrl: string | null;
  mutedAt: string | null;
  occurrences: number;
  tests: string[];
}

type GateRule =
  | { kind: 'BLOCK_ON_VERDICT'; verdict: string; onlyPriorities: string[] }
  | { kind: 'MAX_FLAKE_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MAX_P95_LATENCY_MS'; ms: number; action: 'WARN' | 'BLOCK' }
  | { kind: 'MIN_PASS_RATE'; ratePercent: number; action: 'WARN' | 'BLOCK' };

/** Plain-English for each rule, because "MAX_FLAKE_RATE" is not a sentence. */
function describeRule(rule: GateRule): string {
  switch (rule.kind) {
    case 'BLOCK_ON_VERDICT':
      return `Block the deploy when triage calls a failure a ${rule.verdict.toLowerCase().replace('_', ' ')}${
        rule.onlyPriorities.length
          ? `, but only for ${rule.onlyPriorities.map((p) => p.toLowerCase().replace('_', ' ')).join(' or ')} tests`
          : ''
      }.`;
    case 'MAX_FLAKE_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when more than ${rule.ratePercent}% of tests are flaky.`;
    case 'MAX_P95_LATENCY_MS':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the 95th-percentile test takes longer than ${rule.ms}ms.`;
    case 'MIN_PASS_RATE':
      return `${rule.action === 'BLOCK' ? 'Block' : 'Warn'} when the pass rate falls below ${rule.ratePercent}%.`;
  }
}

interface FlakyTest {
  id: string;
  name: string;
  filePath: string;
  flakeRate: number;
  quarantined: boolean;
  lastRunAt: string | null;
}

const SEVERITY: Record<string, string> = {
  CRITICAL: 'border-fail/50 bg-fail/10 text-fail',
  SERIOUS: 'border-fail/40 bg-fail/5 text-fail',
  MODERATE: 'border-flake/40 bg-flake/10 text-flake',
  MINOR: 'border-line text-ink-dim',
};

export default function QualityPage() {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<'findings' | 'flaky' | 'gates'>('findings');
  const [rules, setRules] = useState<GateRule[]>([]);
  const [savingRules, setSavingRules] = useState(false);
  const [ruleNote, setRuleNote] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (projectId: string) => {
    const [f, q] = await Promise.all([
      api<{ findings: Finding[] }>(`/projects/${projectId}/findings`).catch(() => ({
        findings: [] as Finding[],
      })),
      api<{ tests: FlakyTest[] }>(`/projects/${projectId}/flaky`).catch(() => ({
        tests: [] as FlakyTest[],
      })),
    ]);
    setFindings(f.findings);
    setFlaky(q.tests);
    const g = await api<{ rules: GateRule[] }>(`/projects/${projectId}/gate-rules`).catch(() => ({
      rules: [] as GateRule[],
    }));
    setRules(g.rules);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const { projects } = await api<{ projects: Project[] }>('/projects');
        const first = projects[0];
        if (!first) return;
        setProject(first);
        await load(first.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load quality data');
      }
    })();
  }, [router, load]);

  async function mute(finding: Finding) {
    if (!project) return;
    await api(`/projects/${project.id}/findings/${finding.id}/mute`, {
      method: 'POST',
      body: JSON.stringify({ muted: !finding.mutedAt }),
    }).catch(() => {});
    await load(project.id);
  }

  async function quarantine(test: FlakyTest) {
    if (!project) return;
    await api(`/projects/${project.id}/tests/${test.id}/quarantine`, {
      method: 'POST',
      body: JSON.stringify({ quarantined: !test.quarantined }),
    }).catch(() => {});
    await load(project.id);
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Quality</h1>
      <p className="text-ink-dim mt-1 mb-6 text-sm">
        What&rsquo;s wrong with the app, and what&rsquo;s wrong with the tests.
      </p>

      {error && (
        <p className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}

      <nav className="border-line mb-6 flex gap-1 border-b">
        {(
          [
            ['findings', `Findings (${findings.length})`],
            ['flaky', `Flake radar (${flaky.length})`],
            ['gates', `Deploy gates (${rules.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === id ? 'border-accent text-ink' : 'text-ink-faint hover:text-ink border-transparent'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'gates' ? (
        <div className="space-y-4">
          <p className="text-ink-dim text-sm">
            These decide whether a run blocks a deploy. A <span className="text-fail">block</span>{' '}
            fails the CI gate; a <span className="text-flake">warn</span> is recorded and lets the
            merge through.
          </p>

          <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-xl border">
            {rules.map((rule, index) => (
              <div key={index} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                    ('action' in rule ? rule.action : 'BLOCK') === 'BLOCK'
                      ? 'border-fail/40 text-fail'
                      : 'border-flake/40 text-flake'
                  }`}
                >
                  {'action' in rule ? rule.action.toLowerCase() : 'block'}
                </span>
                <p className="min-w-0 flex-1 text-[13px]">{describeRule(rule)}</p>
                <button
                  type="button"
                  onClick={() => setRules(rules.filter((_, i) => i !== index))}
                  className="text-fail shrink-0 text-xs hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            {rules.length === 0 && (
              <p className="text-ink-faint px-4 py-8 text-center text-sm">
                No gates. Every run passes, whatever it finds.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setRules([
                  ...rules,
                  { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
                ])
              }
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              + Block on real bugs
            </button>
            <button
              type="button"
              onClick={() =>
                setRules([...rules, { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' }])
              }
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              + Flake ceiling
            </button>
            <button
              type="button"
              onClick={() =>
                setRules([...rules, { kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }])
              }
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              + Minimum pass rate
            </button>
            <button
              type="button"
              onClick={() =>
                setRules([...rules, { kind: 'MAX_P95_LATENCY_MS', ms: 30000, action: 'WARN' }])
              }
              className="border-line hover:border-accent rounded-md border px-2.5 py-1 text-xs"
            >
              + Latency ceiling
            </button>

            <button
              type="button"
              disabled={savingRules || !project}
              onClick={async () => {
                if (!project) return;
                setSavingRules(true);
                setRuleNote(null);
                try {
                  await api(`/projects/${project.id}/gate-rules`, {
                    method: 'PUT',
                    body: JSON.stringify({ rules }),
                  });
                  setRuleNote('Saved. New runs are gated on these.');
                } catch (err) {
                  setRuleNote(err instanceof Error ? err.message : 'Could not save');
                } finally {
                  setSavingRules(false);
                }
              }}
              className="bg-accent ml-auto rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {savingRules ? 'Saving…' : 'Save gates'}
            </button>
          </div>
          {ruleNote && <p className="text-ink-dim text-xs">{ruleNote}</p>}
        </div>
      ) : tab === 'findings' ? (
        <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-xl border">
          {findings.map((f) => (
            <div key={f.id} className={`px-4 py-3 ${f.mutedAt ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                    SEVERITY[f.severity] ?? SEVERITY.MINOR
                  }`}
                >
                  {f.severity.toLowerCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px]">{f.message}</p>
                  <p className="text-ink-faint mt-0.5 truncate font-mono text-[11px]">
                    {f.location}
                  </p>
                  <p className="text-ink-faint mt-1 text-[10px]">
                    {f.kind.toLowerCase()} · {f.code} · seen {f.occurrences}×
                    {f.tests.length > 0 && ` · ${f.tests.slice(0, 2).join(', ')}`}
                  </p>
                </div>
                {f.helpUrl && (
                  <a
                    href={f.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent shrink-0 text-xs hover:underline"
                  >
                    How to fix
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void mute(f)}
                  className="text-ink-faint hover:text-ink shrink-0 text-xs"
                >
                  {f.mutedAt ? 'Unmute' : 'Mute'}
                </button>
              </div>
            </div>
          ))}
          {findings.length === 0 && (
            <p className="text-ink-faint px-4 py-10 text-center text-sm">
              No findings yet. Accessibility and security checks record them as they run.
            </p>
          )}
        </div>
      ) : (
        <div className="border-line divide-line bg-surface-1 divide-y overflow-hidden rounded-xl border">
          {flaky.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px]">{t.name}</p>
                <p className="text-ink-faint truncate font-mono text-[11px]">{t.filePath}</p>
              </div>
              <span
                className={`shrink-0 font-mono text-xs ${
                  t.flakeRate > 20 ? 'text-fail' : t.flakeRate > 5 ? 'text-flake' : 'text-ink-dim'
                }`}
                title="Share of recent runs that were unstable"
              >
                {t.flakeRate.toFixed(1)}%
              </span>
              {t.quarantined && (
                <span className="border-flake/40 text-flake shrink-0 rounded border px-1.5 py-0.5 text-[10px]">
                  quarantined
                </span>
              )}
              <button
                type="button"
                onClick={() => void quarantine(t)}
                className="border-line hover:border-accent shrink-0 rounded-md border px-2.5 py-1 text-xs"
              >
                {t.quarantined ? 'Release' : 'Quarantine'}
              </button>
            </div>
          ))}
          {flaky.length === 0 && (
            <p className="text-ink-faint px-4 py-10 text-center text-sm">
              No unstable tests. A quarantined test still runs — it just stops gating a deploy.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
