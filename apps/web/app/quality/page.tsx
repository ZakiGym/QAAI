'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../lib/api';
import { relativeTime, SeverityLabel } from '../../components/ui';
import { useProject } from '../../components/shell/ProjectContext';
import { SECTION_TABS_SLOT_ID } from '../../components/shell/AppShell';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Badge, Page, PageHeader, SectionLabel, SkeletonRows } from '../../components/ui/layout';
import { GateRuleRow, type GateRule } from '../../components/triage/GateRuleRow';

/**
 * Quality — the gates, the flake radar and the findings, on one screen.
 *
 * They belong together because they answer the same question from three sides:
 * what stops a deploy, which tests cannot be trusted to answer that, and what
 * is actually wrong with the app. All three were fully recorded and completely
 * invisible — findings only ever appeared inside a single test result, and
 * flakeRate was maintained on every run and never shown, so "which tests can I
 * not trust" had no answer at all.
 *
 * They are stacked rather than tabbed: the section strip above already switches
 * views, and a second row of tabs under it would make the same gesture mean two
 * different things.
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

interface FlakyTest {
  id: string;
  name: string;
  filePath: string;
  flakeRate: number;
  quarantined: boolean;
  lastRunAt: string | null;
}

/** Above 20% it is a liability, above 5% it is worth watching. */
function flakeTone(rate: number): string {
  if (rate > 20) return 'text-fail';
  if (rate > 5) return 'text-flake';
  return 'text-ink-dim';
}

function flakeFill(rate: number): string {
  if (rate > 20) return 'bg-fail';
  if (rate > 5) return 'bg-flake';
  return 'bg-ink-faint';
}

export default function QualityPage() {
  const router = useRouter();
  // Was `projects[0]` — this screen silently reported on whichever project came
  // back first and never said which one that was.
  const { project, projectId, loading: projectLoading } = useProject();
  const [rules, setRules] = useState<GateRule[]>([]);
  const [savingRules, setSavingRules] = useState(false);
  const [ruleNote, setRuleNote] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  // Every collection starts `[]`, so the empty state — "Nothing flagged." — was
  // what a user saw while the fetch was still in flight.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      // A dead endpoint falls back to empty rather than blanking the screen —
      // but a 401 still sends you to sign in.
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

  async function saveRules() {
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
  }

  function addRule(kind: GateRule['kind']) {
    setAddOpen(false);
    setRules((current) => [...current, blankRule(kind)]);
  }

  const busy = loading || projectLoading;

  return (
    <Page width="triage">
      <PageHeader
        /* Section, not tab — see the note on /heals. */
        eyebrow={project ? `${project.name} · Quality` : 'Quality'}
        title="Triage"
        subtitle={<>What&rsquo;s wrong with the app, and what&rsquo;s wrong with the tests.</>}
      />

      {/* The section strip — VERDICTS / HEALS / QUALITY — is the shell's. */}
      <div id={SECTION_TABS_SLOT_ID} />

      {error && (
        <p
          role="alert"
          className="border-fail/40 text-fail text-body-sm mt-5 rounded-lg border bg-[color-mix(in_srgb,var(--color-fail)_10%,transparent)] p-3"
        >
          {error}
        </p>
      )}

      <section className="mt-5">
        <SectionLabel className="mb-1.5">Gate rules</SectionLabel>
        {busy ? (
          <SkeletonRows rows={3} />
        ) : rules.length === 0 ? (
          <EmptyState
            title="No gates."
            body="Every run passes, whatever it finds. Add a rule and the next run is measured against it."
            action={{ label: 'Block on real bugs', onClick: () => addRule('BLOCK_ON_VERDICT') }}
          />
        ) : (
          <div>
            {rules.map((rule, index) => (
              <GateRuleRow
                key={index}
                rule={rule}
                onChange={(next) => setRules(rules.map((r, i) => (i === index ? next : r)))}
                onRemove={() => setRules(rules.filter((_, i) => i !== index))}
              />
            ))}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          <button
            type="button"
            onClick={() => setAddOpen((open) => !open)}
            aria-expanded={addOpen}
            className="text-accent text-[12px] hover:underline"
          >
            + add a rule
          </button>
          {/* Both clauses are enforced in packages/runner/src/gates.ts, which
              excludes quarantined tests from every rule and counts a retry that
              passed as flaky. */}
          <span className="text-ink-faint font-mono text-[10.5px]">
            · quarantined tests never block · a retry that passes counts as flaky
          </span>
          {rules.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              className="ml-auto"
              loading={savingRules}
              disabled={!projectId}
              onClick={() => void saveRules()}
            >
              {savingRules ? 'Saving…' : 'Save gates'}
            </Button>
          )}
        </div>

        {addOpen && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => addRule('BLOCK_ON_VERDICT')}>
              Block on real bugs
            </Button>
            <Button size="sm" onClick={() => addRule('MAX_FLAKE_RATE')}>
              Flake ceiling
            </Button>
            <Button size="sm" onClick={() => addRule('MIN_PASS_RATE')}>
              Minimum pass rate
            </Button>
            <Button size="sm" onClick={() => addRule('MAX_P95_LATENCY_MS')}>
              Latency ceiling
            </Button>
          </div>
        )}
        {ruleNote && <p className="text-ink-dim mt-2 text-xs">{ruleNote}</p>}
      </section>

      <section className="mt-8">
        <SectionLabel className="mb-1.5">Flake radar</SectionLabel>
        {busy ? (
          <SkeletonRows rows={4} />
        ) : flaky.length === 0 ? (
          <EmptyState
            title="No unstable tests."
            body="Nothing has flaked in the last fifty results. A quarantined test still runs — it just stops gating a deploy."
          />
        ) : (
          <>
            <div>
              {flaky.map((test) => (
                <div key={test.id} className="border-line flex items-center gap-3.5 border-b py-[11px]">
                  {/*
                    The radar could tell you a test was 22% unreliable and give
                    you exactly two things to do about it: quarantine it, or
                    nothing. The next question is always the same one — is it
                    always like this, or did it start on Tuesday? — and the
                    answer is the test's own history.
                  */}
                  <Link
                    href={`/tests/${test.id}`}
                    title={`${test.filePath} — pass rate over time, and when it started failing`}
                    className="text-row hover:text-accent min-w-0 flex-1 truncate transition-colors"
                  >
                    {test.name}
                  </Link>
                  {test.lastRunAt && (
                    <span className="text-ink-faint shrink-0 font-mono text-[10px] tabular-nums">
                      {relativeTime(test.lastRunAt)}
                    </span>
                  )}
                  <span
                    className="bg-surface-2 h-1 w-[90px] shrink-0 overflow-hidden rounded-full"
                    aria-hidden="true"
                  >
                    <span
                      className={`block h-full ${flakeFill(test.flakeRate)}`}
                      style={{ width: `${Math.min(100, test.flakeRate)}%` }}
                    />
                  </span>
                  <span
                    className={`w-[34px] shrink-0 text-right font-mono text-[11.5px] tabular-nums ${flakeTone(test.flakeRate)}`}
                    title="Share of the last fifty results that were unstable"
                  >
                    {Math.round(test.flakeRate)}%
                  </span>
                  {test.quarantined ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone="flake" tint>
                        QUARANTINED
                      </Badge>
                      <button
                        type="button"
                        onClick={() => void quarantine(test)}
                        className="text-ink-faint hover:text-ink text-[11.5px] transition-colors"
                      >
                        release
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void quarantine(test)}
                      className="text-ink-faint hover:text-ink shrink-0 text-[11.5px] transition-colors"
                    >
                      quarantine
                    </button>
                  )}
                </div>
              ))}
            </div>
            {/*
              The rate really is the last fifty results (updateFlakeStats takes
              50). The threshold is deliberately not printed: auto-quarantine is
              per-project policy and only fires after the test has been re-run
              and measured, so a number here would be a promise this screen
              cannot keep.
            */}
            <p className="text-ink-faint mt-2.5 font-mono text-[10.5px]">
              rolling rate over the last 50 results · a suspected flake is re-run and measured
              before anything is quarantined
            </p>
          </>
        )}
      </section>

      <section className="mt-8">
        <SectionLabel className="mb-1.5">Findings</SectionLabel>
        {busy ? (
          <SkeletonRows rows={4} />
        ) : findings.length === 0 ? (
          <EmptyState
            title="Nothing flagged."
            body="Accessibility and security checks record findings here as they run — an empty list means the last run was clean."
          />
        ) : (
          <div>
            {findings.map((finding) => (
              <div
                key={finding.id}
                className={`border-line flex items-baseline gap-3 border-b py-[11px] ${
                  finding.mutedAt ? 'opacity-50' : ''
                }`}
              >
                <span className="w-[70px] shrink-0">
                  <SeverityLabel severity={finding.severity} />
                </span>
                <p className="text-row min-w-0 flex-1">
                  {finding.message}
                  <span className="text-ink-faint">
                    {' — '}
                    {finding.kind.toLowerCase().replace(/_/g, ' ')} · {finding.code}
                    {finding.location ? ` · ${finding.location}` : ''}
                  </span>
                </p>
                {finding.helpUrl && (
                  <a
                    href={finding.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent shrink-0 text-[11.5px] hover:underline"
                  >
                    how to fix
                  </a>
                )}
                <span className="text-ink-faint shrink-0 font-mono text-[11px] tabular-nums">
                  ×{finding.occurrences}
                </span>
                <button
                  type="button"
                  onClick={() => void mute(finding)}
                  className="text-ink-faint hover:text-ink shrink-0 text-[11.5px] transition-colors"
                >
                  {finding.mutedAt ? 'unmute' : 'mute'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}

/** A new rule starts at the value a team would most likely have chosen. */
function blankRule(kind: GateRule['kind']): GateRule {
  switch (kind) {
    case 'BLOCK_ON_VERDICT':
      return { kind, verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] };
    case 'MAX_FLAKE_RATE':
      return { kind, ratePercent: 5, action: 'WARN' };
    case 'MIN_PASS_RATE':
      return { kind, ratePercent: 90, action: 'BLOCK' };
    case 'MAX_P95_LATENCY_MS':
      return { kind, ms: 30_000, action: 'WARN' };
  }
}
