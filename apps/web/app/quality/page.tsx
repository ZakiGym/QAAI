'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { relativeTime } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge, Card, Page, PageHeader, SkeletonRows, Tabs } from '../../components/ui/layout';

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

const SEVERITY_TONE: Record<string, 'fail' | 'flake' | 'neutral'> = {
  CRITICAL: 'fail',
  SERIOUS: 'fail',
  MODERATE: 'flake',
  MINOR: 'neutral',
};

export default function QualityPage() {
  const router = useRouter();
  // Was `projects[0]` — this screen silently reported on whichever project came
  // back first and never said which one that was.
  const { projectId, loading: projectLoading } = useProject();
  const [tab, setTab] = useState<'findings' | 'flaky' | 'gates'>('findings');
  const [rules, setRules] = useState<GateRule[]>([]);
  const [savingRules, setSavingRules] = useState(false);
  const [ruleNote, setRuleNote] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  // Every collection starts `[]`, so the empty state — "Nothing flagged." — was
  // what a user saw while the fetch was still in flight.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      // A dead endpoint falls back to empty rather than blanking the screen,
      // exactly as before — but a 401 still sends you to sign in, which is what
      // this page's own /projects call used to do before the shell owned it.
      const onFail =
        <T,>(fallback: T) =>
        (err: unknown): T => {
          if (err instanceof ApiError && err.status === 401) router.push('/login');
          return fallback;
        };

      const [f, q] = await Promise.all([
        api<{ findings: Finding[] }>(`/projects/${id}/findings`).catch(
          onFail({ findings: [] as Finding[] }),
        ),
        api<{ tests: FlakyTest[] }>(`/projects/${id}/flaky`).catch(
          onFail({ tests: [] as FlakyTest[] }),
        ),
      ]);
      setFindings(f.findings);
      setFlaky(q.tests);
      const g = await api<{ rules: GateRule[] }>(`/projects/${id}/gate-rules`).catch(
        onFail({ rules: [] as GateRule[] }),
      );
      setRules(g.rules);
    },
    [router],
  );

  useEffect(() => {
    // Wait for the shell to settle on a project before deciding there is
    // nothing to show.
    if (projectLoading) return;
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    // Also on a project switch: the previous project's findings must not sit
    // there looking like they belong to the one you just picked.
    setLoading(true);
    void (async () => {
      try {
        await load(projectId);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load quality data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, projectLoading, load]);

  async function mute(finding: Finding) {
    if (!projectId) return;
    await api(`/projects/${projectId}/findings/${finding.id}/mute`, {
      method: 'POST',
      body: JSON.stringify({ muted: !finding.mutedAt }),
    }).catch(() => {});
    await load(projectId);
  }

  async function quarantine(test: FlakyTest) {
    if (!projectId) return;
    await api(`/projects/${projectId}/tests/${test.id}/quarantine`, {
      method: 'POST',
      body: JSON.stringify({ quarantined: !test.quarantined }),
    }).catch(() => {});
    await load(projectId);
  }

  const busy = loading || projectLoading;

  return (
    <Page width="wide">
      <PageHeader
        title="Quality"
        subtitle={
          <>What&rsquo;s wrong with the app, and what&rsquo;s wrong with the tests.</>
        }
      />

      {error && (
        <p className="border-fail/40 bg-fail/10 text-fail mb-6 rounded-md border p-3 text-sm">
          {error}
        </p>
      )}

      <Tabs
        tabs={[
          { id: 'findings', label: 'Findings', count: findings.length },
          { id: 'flaky', label: 'Flake radar', count: flaky.length },
          { id: 'gates', label: 'Deploy gates', count: rules.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'gates' ? (
        <div className="space-y-4">
          <p className="text-ink-dim text-sm">
            These decide whether a run blocks a deploy. A <span className="text-fail">block</span>{' '}
            fails the CI gate; a <span className="text-flake">warn</span> is recorded and lets the
            merge through.
          </p>

          {busy ? (
            <Card className="overflow-hidden">
              <SkeletonRows rows={3} />
            </Card>
          ) : rules.length === 0 ? (
            <EmptyState title="No gates." body="Every run passes, whatever it finds." />
          ) : (
            <Card className="divide-line divide-y overflow-hidden">
              {rules.map((rule, index) => (
                <div key={index} className="flex items-start gap-3 px-4 py-3">
                  <Badge
                    tone={('action' in rule ? rule.action : 'BLOCK') === 'BLOCK' ? 'fail' : 'flake'}
                    mono
                    className="mt-0.5"
                  >
                    {'action' in rule ? rule.action.toLowerCase() : 'block'}
                  </Badge>
                  <p className="min-w-0 flex-1 text-body-sm">{describeRule(rule)}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRules(rules.filter((_, i) => i !== index))}
                    className="text-fail hover:text-fail"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() =>
                setRules([
                  ...rules,
                  { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
                ])
              }
            >
              + Block on real bugs
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setRules([...rules, { kind: 'MAX_FLAKE_RATE', ratePercent: 5, action: 'WARN' }])
              }
            >
              + Flake ceiling
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setRules([...rules, { kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }])
              }
            >
              + Minimum pass rate
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setRules([...rules, { kind: 'MAX_P95_LATENCY_MS', ms: 30000, action: 'WARN' }])
              }
            >
              + Latency ceiling
            </Button>

            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              loading={savingRules}
              disabled={!projectId}
              onClick={async () => {
                if (!projectId) return;
                setSavingRules(true);
                setRuleNote(null);
                try {
                  await api(`/projects/${projectId}/gate-rules`, {
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
            >
              {savingRules ? 'Saving…' : 'Save gates'}
            </Button>
          </div>
          {ruleNote && <p className="text-ink-dim text-xs">{ruleNote}</p>}
        </div>
      ) : tab === 'findings' ? (
        busy ? (
          <Card className="overflow-hidden">
            <SkeletonRows rows={5} />
          </Card>
        ) : findings.length === 0 ? (
          <EmptyState
            title="Nothing flagged."
            body="Accessibility and security checks record findings here as they run — an empty list means the last run was clean."
          />
        ) : (
          <Card className="divide-line divide-y overflow-hidden">
            {findings.map((f) => (
              <div key={f.id} className={`px-4 py-3 ${f.mutedAt ? 'opacity-50' : ''}`}>
                <div className="flex items-start gap-3">
                  <Badge tone={SEVERITY_TONE[f.severity] ?? 'neutral'} mono>
                    {f.severity.toLowerCase()}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm">{f.message}</p>
                    <p className="text-ink-faint mt-0.5 truncate font-mono text-micro">
                      {f.location}
                    </p>
                    <p className="text-ink-faint mt-1 text-meta">
                      {f.kind.toLowerCase()} · {f.code} · seen{' '}
                      <span className="tabular-nums">{f.occurrences}</span>×
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
                  <Button variant="ghost" size="sm" onClick={() => void mute(f)}>
                    {f.mutedAt ? 'Unmute' : 'Mute'}
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        )
      ) : busy ? (
        <Card className="overflow-hidden">
          <SkeletonRows rows={5} />
        </Card>
      ) : flaky.length === 0 ? (
        <EmptyState
          title="No unstable tests."
          body="A quarantined test still runs — it just stops gating a deploy."
        />
      ) : (
        <Card className="divide-line divide-y overflow-hidden">
          {flaky.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body-sm">{t.name}</p>
                <p className="text-ink-faint truncate font-mono text-micro">{t.filePath}</p>
              </div>
              {t.lastRunAt && (
                <span className="text-ink-faint shrink-0 text-meta tabular-nums">
                  {relativeTime(t.lastRunAt)}
                </span>
              )}
              <span
                className={`shrink-0 font-mono text-xs tabular-nums ${
                  t.flakeRate > 20 ? 'text-fail' : t.flakeRate > 5 ? 'text-flake' : 'text-ink-dim'
                }`}
                title="Share of recent runs that were unstable"
              >
                {t.flakeRate.toFixed(1)}%
              </span>
              {t.quarantined && <Badge tone="flake">quarantined</Badge>}
              <Button size="sm" onClick={() => void quarantine(t)}>
                {t.quarantined ? 'Release' : 'Quarantine'}
              </Button>
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}
