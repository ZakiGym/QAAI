'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../../../lib/api';
import { Button } from '../../../../components/ui/Button';
import { Page, PageHeader, SectionLabel } from '../../../../components/ui/layout';

/**
 * Plan approval (§3.1) — the human gate between the Explorer and the Generator.
 *
 * The Explorer proposes tests in plain English, grouped by feature and ranked
 * by priority. Nothing is written until the person ticks boxes and approves;
 * that is the whole point of the step, and it is why the agent cannot generate
 * code on its own.
 */

interface PlanItem {
  id: string;
  title: string;
  rationale: string;
  feature: string;
  priority: 'CRITICAL_PATH' | 'IMPORTANT' | 'NICE_TO_HAVE';
  testType: string;
  steps: string[];
  assertions: string[];
  state: string;
  /** Set once the Generator has written code for this item. */
  generatedTestId?: string | null;
}

/**
 * The items this screen can still act on.
 *
 * PROPOSED is the Explorer's cold proposal, waiting for a human to tick it.
 * APPROVED-without-a-test is a different thing that lands in the same place:
 * the coverage-gap, traffic and repro flows pre-approve, because selecting the
 * gap WAS the approval. Those items still need the Generator run on them, and
 * filtering to PROPOSED alone dropped them off this page entirely — a plan
 * created from coverage gaps rendered as nothing but its "deliberately skipped"
 * list, which reads as "we did nothing" when in fact the work is sitting there.
 */
function isActionable(item: PlanItem): boolean {
  if (item.state === 'PROPOSED') return true;
  return item.state === 'APPROVED' && !item.generatedTestId;
}

interface Plan {
  id: string;
  summary: string;
  skipped: Array<{ what: string; why: string }>;
  items: PlanItem[];
}

const PRIORITY_LABEL: Record<string, string> = {
  CRITICAL_PATH: 'Critical path',
  IMPORTANT: 'Important',
  NICE_TO_HAVE: 'Nice to have',
};

const PRIORITY_STYLE: Record<string, string> = {
  CRITICAL_PATH: 'text-fail',
  IMPORTANT: 'text-flake',
  NICE_TO_HAVE: 'text-ink-faint',
};

export default function PlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { plan } = await api<{ plan: Plan }>(`/projects/${projectId}/plan`);
      setPlan(plan);
      // Everything still actionable starts ticked; unticking is the edit.
      setSelected(new Set(plan.items.filter(isActionable).map((i) => i.id)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setError('No plan yet — run the Explorer first.');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load the plan');
    }
  }, [projectId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approve() {
    if (!plan || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/plans/${plan.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedItemIds: [...selected] }),
      });
      // The Generator now runs in the worker; the tests appear in the editor.
      router.push('/editor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve');
    } finally {
      setBusy(false);
    }
  }

  if (error && !plan) {
    return (
      <Page width="narrow">
        <p className="text-fail">{error}</p>
        <Link href="/onboarding" className="text-accent mt-4 inline-block text-sm">
          Run the Explorer
        </Link>
      </Page>
    );
  }
  if (!plan)
    return (
      <Page width="narrow" className="text-ink-faint text-sm">
        Loading the plan…
      </Page>
    );

  const proposable = plan.items.filter(isActionable);
  const preApproved = proposable.filter((i) => i.state === 'APPROVED').length;
  const alreadyGenerated = plan.items.filter(
    (i) => i.state === 'GENERATED' || i.generatedTestId,
  ).length;

  // Group in priority order so the critical-path tests are what the eye lands on.
  const groups = new Map<string, PlanItem[]>();
  for (const item of proposable) {
    groups.set(item.feature, [...(groups.get(item.feature) ?? []), item]);
  }

  return (
    <Page width="narrow">
      <PageHeader
        title="Proposed test plan"
        subtitle={
          <>
            {plan.summary}
            {preApproved > 0 && (
              <span className="text-ink-faint mt-2 block">
                <span className="tabular-nums">{preApproved}</span> item
                {preApproved === 1 ? ' was' : 's were'} already approved when{' '}
                {preApproved === 1 ? 'it was' : 'they were'} selected — choosing the gap was the
                approval. {preApproved === 1 ? 'It is' : 'They are'} waiting on the Generator, not
                on you.
              </span>
            )}
            {alreadyGenerated > 0 && (
              <span className="text-ink-faint mt-2 block">
                <span className="tabular-nums">{alreadyGenerated}</span> item
                {alreadyGenerated === 1 ? '' : 's'} already generated.
              </span>
            )}
          </>
        }
      />

      <div className="space-y-6">
        {/* Never let the page fall through to nothing but the skipped list. */}
        {proposable.length === 0 && (
          <p className="border-line text-ink-dim rounded-lg border border-dashed p-4 text-sm">
            {alreadyGenerated > 0
              ? 'Every item on this plan has been generated. The tests are in the editor.'
              : 'Nothing on this plan is waiting on a decision — every item was either generated or declined.'}
          </p>
        )}
        {[...groups.entries()].map(([feature, items]) => (
          <section key={feature}>
            <SectionLabel>{feature}</SectionLabel>
            <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
              {items.map((item) => {
                const isOpen = expanded.has(item.id);
                return (
                  <div key={item.id} className="bg-surface-1">
                    <div className="flex items-start gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        className="accent-accent mt-1"
                        aria-label={`Include: ${item.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-sm font-medium">{item.title}</span>
                          <span
                            className={`ml-auto shrink-0 font-mono text-meta ${PRIORITY_STYLE[item.priority]}`}
                          >
                            {PRIORITY_LABEL[item.priority]}
                          </span>
                          <span className="text-ink-faint shrink-0 font-mono text-meta">
                            {item.testType}
                          </span>
                        </div>
                        <p className="text-ink-dim mt-1 text-xs">{item.rationale}</p>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(item.id)) next.delete(item.id);
                              else next.add(item.id);
                              return next;
                            })
                          }
                          className="mt-1 -ml-2.5"
                        >
                          {isOpen ? 'Hide steps' : 'Show steps'}
                        </Button>

                        {isOpen && (
                          <div className="mt-2 space-y-2 text-xs">
                            <ol className="text-ink-dim list-decimal space-y-0.5 pl-4">
                              {item.steps.map((s, i) => (
                                <li key={i}>{s}</li>
                              ))}
                            </ol>
                            <div>
                              <p className="text-ink-faint mb-0.5 font-mono text-meta uppercase">
                                Asserts
                              </p>
                              <ul className="text-ink-dim space-y-0.5">
                                {item.assertions.map((a, i) => (
                                  <li key={i}>· {a}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {plan.skipped.length > 0 && (
        <section className="mt-8">
          <SectionLabel>Deliberately skipped</SectionLabel>
          <ul className="text-ink-faint space-y-1 text-xs">
            {plan.skipped.map((s, i) => (
              <li key={i}>
                <span className="text-ink-dim">{s.what}</span> — {s.why}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="text-fail mt-6 text-sm">{error}</p>}

      {proposable.length > 0 && (
        <div className="border-line bg-surface sticky bottom-0 mt-8 flex items-center gap-3 border-t py-4">
          <span className="text-ink-dim text-sm">
            <span className="tabular-nums">{selected.size}</span> of{' '}
            <span className="tabular-nums">{proposable.length}</span> selected
          </span>
          <Button
            variant="primary"
            className="ml-auto tabular-nums"
            disabled={selected.size === 0}
            loading={busy}
            onClick={() => void approve()}
          >
            {busy
              ? 'Generating…'
              : `Generate ${selected.size} test${selected.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </Page>
  );
}
