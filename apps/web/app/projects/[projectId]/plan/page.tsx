'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../../../lib/api';
import { Button } from '../../../../components/ui/Button';
import Link from 'next/link';
import { EmptyState } from '../../../../components/ui/EmptyState';
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

/**
 * What THIS project can be offered when it turns out to have no plan.
 *
 * The 404 branch used to say "run the Explorer" and link /onboarding, which is
 * the add-a-NEW-app funnel. Everybody who lands here already has an app — the
 * three ways in are the fleet tile on /runs, the run cards, and the editor's
 * "Review the test plan →" — so the recovery invited them to create a SECOND
 * project to fix the first one's missing plan, and nothing on that path ever
 * came back here. The person lost their way out; the org gained a stray app.
 *
 * Which action is honest depends on two facts that disagree with each other
 * often enough to matter: an environment is what the Explorer crawls, and a
 * codebase snapshot is what the static analyser reads. A project can have
 * either, both, or neither, and the old copy assumed the only combination that
 * is never true on this screen — that there is no app at all.
 */
interface Recovery {
  projectName: string;
  /** The environment the Explorer would crawl. Null when the app has none. */
  environmentId: string | null;
  /** A codebase upload exists, so `analyze-source` has something to read. */
  hasSnapshot: boolean;
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

/**
 * How long the screen waits for a job it started before saying it stopped
 * waiting. Longer than a 25-page crawl, shorter than a meeting.
 */
const POLL_BUDGET_MS = 3 * 60 * 1000;

export default function PlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when the approval succeeded but the Generator was NOT queued, which is
   * what this deployment answers when it has no ANTHROPIC_API_KEY. Routing to
   * /editor in that case sends someone to watch an empty screen for code that
   * is never coming, so the sentence the API returned is shown here instead.
   */
  const [notGenerated, setNotGenerated] = useState<{ headline: string; detail: string } | null>(
    null,
  );
  /** This project has no plan yet — not an error, a state with a way out of it. */
  const [missing, setMissing] = useState(false);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [starting, setStarting] = useState<'explore' | 'analyze' | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  /** The poll stopped waiting. Said out loud rather than spun on forever. */
  const [gaveUp, setGaveUp] = useState(false);
  /**
   * Kept apart from `error` on purpose: a failed start is a failure of the
   * recovery, and folding it into `error` would replace the empty state — and
   * with it the button that failed — with a bare sentence and no way to retry.
   */
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { plan } = await api<{ plan: Plan }>(`/projects/${projectId}/plan`);
      setPlan(plan);
      setMissing(false);
      // Everything still actionable starts ticked; unticking is the edit.
      setSelected(new Set(plan.items.filter(isActionable).map((i) => i.id)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.push('/login');
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setMissing(true);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load the plan');
    }
  }, [projectId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Ask the project what it can do, once, and only when it turns out there is
   * nothing to approve. Both reads are scoped to the id in the URL rather than
   * to the globally selected project: somebody can arrive here on a link to an
   * app that is not the one the sidebar has selected, and offering to crawl the
   * OTHER app would be the same class of mistake as sending them to /onboarding.
   */
  useEffect(() => {
    if (!missing || recovery) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ project }, source] = await Promise.all([
          api<{ project: { name: string; environments: Array<{ id: string }> } }>(
            `/projects/${projectId}`,
          ),
          // A project with no upload answers 200 with `snapshot: null`, so a
          // throw here is a real failure and must not be read as "no codebase".
          api<{ snapshot: { id: string } | null }>(`/projects/${projectId}/source`),
        ]);
        if (cancelled) return;
        setRecovery({
          projectName: project.name,
          environmentId: project.environments[0]?.id ?? null,
          hasSnapshot: Boolean(source.snapshot),
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push('/login');
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not load this app');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missing, recovery, projectId, router]);

  /*
   * Poll once something has been started. Both jobs are enqueued and run in the
   * worker, so the POST answers 202 with nothing to navigate to; without this
   * the button would press, say something reassuring, and then leave the screen
   * exactly as empty as it was — a dead end with better copy.
   */
  useEffect(() => {
    if (!started || plan || gaveUp) return;
    /*
     * Bounded, because an unbounded poll is the same reassuring lie in slower
     * motion: if the worker dies, this screen sits under "the proposed plan
     * appears here when the Explorer finishes" and 404s forever. Three minutes
     * is comfortably longer than a 25-page crawl and short enough that nobody
     * watches an empty panel through a meeting.
     */
    const deadline = Date.now() + POLL_BUDGET_MS;
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        setGaveUp(true);
        return;
      }
      void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [started, plan, gaveUp, load]);

  async function startExplorer(environmentId: string) {
    if (starting) return;
    setStarting('explore');
    setRecoveryError(null);
    try {
      // Same call the flow map's re-crawl makes. The Explorer drives a real
      // browser and needs no model, so this works on a deployment with no key.
      await api(`/projects/${projectId}/explore`, {
        method: 'POST',
        body: JSON.stringify({ environmentId, maxPages: 25, maxDepth: 3 }),
      });
      setStarted('Crawling your app. The proposed plan appears here when the Explorer finishes.');
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Could not start the Explorer');
    } finally {
      setStarting(null);
    }
  }

  async function analyzeSource() {
    if (starting) return;
    setStarting('analyze');
    setRecoveryError(null);
    try {
      await api(`/projects/${projectId}/analyze-source`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStarted(
        'Reading the codebase you uploaded. The proposed plan appears here when it finishes.',
      );
    } catch (err) {
      setRecoveryError(err instanceof Error ? err.message : 'Could not read the codebase');
    } finally {
      setStarting(null);
    }
  }

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
    // Clear last attempt's verdict before asking again. Without this, a retry
    // that succeeds leaves "no test code was written" on screen underneath it.
    setNotGenerated(null);
    try {
      const result = await api<{
        approved: number;
        generation?: { queued: boolean; scaffolded?: number; reason?: string };
      }>(`/plans/${plan.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedItemIds: [...selected] }),
      });

      /*
       * A `reason` means something on this deployment could not run the full
       * Generator — no key. That now comes in two honest flavours: nothing was
       * written, or the spec-driven subset was scaffolded deterministically
       * while the code items wait for a key. Either way the person stays here
       * to read which one happened, instead of being sent to an editor that
       * may or may not have anything in it.
       */
      if (result.generation && (result.generation.queued === false || result.generation.reason)) {
        const scaffolded = result.generation.scaffolded ?? 0;
        setNotGenerated({
          headline:
            scaffolded > 0
              ? 'Approved — scaffolded without a model.'
              : 'Approved — but no test code was written.',
          detail:
            result.generation.reason ??
            'The approval was saved, but no test code was written on this deployment.',
        });
        await load();
        return;
      }

      // The Generator now runs in the worker; the tests appear in the editor.
      router.push('/editor');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve');
    } finally {
      setBusy(false);
    }
  }

  /*
   * A load failure, with no plan to fall back on.
   *
   * This used to return the sentence alone, which put a bare dead end back on
   * the screen this whole change exists to remove — and it sat ABOVE the
   * `missing` branch, so a project that had a perfectly good recovery to offer
   * lost it the moment any one of the three lookups hiccuped. The message
   * stays; a way out goes with it.
   */
  if (error && !plan) {
    return (
      <Page width="narrow">
        <EmptyState
          title="Could not load this app's plan"
          body={error}
          action={{ label: 'Try again', onClick: () => void load() }}
        />
      </Page>
    );
  }

  /*
   * No plan for THIS project. Every action below names the id in the URL, and
   * none of them leaves for /onboarding — the whole point of the fix.
   */
  if (missing && !plan) {
    // Hoisted so the click handlers close over a `const` TypeScript can narrow;
    // reading `recovery.environmentId` inside them would need a `!`, and a `!`
    // on the one value that decides what this screen offers is the wrong place
    // to be telling the compiler to trust us.
    const environmentId = recovery?.environmentId ?? null;
    const hasSnapshot = recovery?.hasSnapshot ?? false;

    return (
      <Page width="narrow">
        {recovery ? (
          <EmptyState
            title={`No test plan for ${recovery.projectName} yet`}
            body={
              environmentId
                ? 'The Explorer crawls this app and proposes tests in plain English, grouped by feature. Nothing is written until you tick the ones you want, right here.'
                : hasSnapshot
                  ? 'Nothing has crawled this app yet, but its codebase is uploaded. QAAI can propose scenarios from what the source declares — a static read, so add an environment when you want the crawl as well.'
                  : 'The Explorer proposes a plan by crawling a running copy of this app, and this app has nowhere to crawl yet. Point it at a URL and the plan is one crawl away.'
            }
            action={
              environmentId
                ? {
                    label: starting === 'explore' ? 'Starting the Explorer…' : 'Run the Explorer',
                    onClick: () => void startExplorer(environmentId),
                  }
                : hasSnapshot
                  ? {
                      label: starting === 'analyze' ? 'Reading the codebase…' : 'Read the codebase',
                      onClick: () => void analyzeSource(),
                    }
                  : { label: 'Add an environment', href: '/environments' }
            }
            secondary={
              environmentId && hasSnapshot
                ? {
                    label:
                      starting === 'analyze'
                        ? 'Reading the codebase…'
                        : 'Read the codebase instead',
                    onClick: () => void analyzeSource(),
                  }
                : !environmentId && hasSnapshot
                  ? { label: 'Add an environment', href: '/environments' }
                  : undefined
            }
          />
        ) : (
          <p className="text-ink-faint text-sm">Loading this app…</p>
        )}

        {started && !gaveUp && (
          <p role="status" className="text-ink-dim mt-4 text-center text-sm">
            {started}
          </p>
        )}

        {/*
          The job was started and never produced a plan. Saying so — and naming
          where the answer is — beats spinning under a reassuring sentence,
          which is the failure this screen was rewritten to stop making.
        */}
        {gaveUp && (
          <p role="status" className="text-flake mt-4 text-center text-sm">
            No plan has appeared yet. The job may still be queued, or the worker may have
            stopped —{' '}
            <Link href="/runs" className="underline underline-offset-2">
              check the run queue
            </Link>
            , or press the button again.
          </p>
        )}
        {recoveryError && (
          <p role="alert" className="text-fail mt-4 text-center text-sm">
            {recoveryError}
          </p>
        )}
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
            {/*
              This sentence used to end "waiting on the Generator, not on you"
              unconditionally. After an approval the Generator did not pick up,
              `load()` brings those items back as APPROVED-without-a-test, so the
              header said the Generator was coming while the banner at the bottom
              of the same screen said no code had been written. Two claims, one
              screen, opposite meanings — and the false one was the one that told
              the user to sit and wait.
            */}
            {preApproved > 0 && (
              <span className="text-ink-faint mt-2 block">
                <span className="tabular-nums">{preApproved}</span> item
                {preApproved === 1 ? ' was' : 's were'} already approved when{' '}
                {preApproved === 1 ? 'it was' : 'they were'} selected — choosing the gap was the
                approval.{' '}
                {notGenerated
                  ? `${preApproved === 1 ? 'It is' : 'They are'} approved and unwritten; see below.`
                  : `${preApproved === 1 ? 'It is' : 'They are'} waiting on the Generator, not on you.`}
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

      {/*
        Approved, but nothing was generated. Deliberately not styled as an error
        — the approval succeeded and is durable — and deliberately not a
        redirect, because the place this used to send people has nothing in it.
      */}
      {notGenerated && (
        <div
          role="status"
          className="border-flake/40 bg-flake/10 mt-6 rounded-lg border p-4 text-sm"
        >
          <p className="font-medium">{notGenerated.headline}</p>
          {/*
            Every reason the API returns here already states that the approval
            was saved — that is the one fact this banner must not omit. A second
            sentence from the client repeating it read as two different messages
            about the same thing, and the retry affordance is the button below,
            which relabels itself rather than needing its own control.
          */}
          <p className="text-ink-dim mt-1.5">{notGenerated.detail}</p>
        </div>
      )}

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
            {/*
              After a failed generation the label used to stay "Generate N
              tests", which reads as an untried action — the user presses it,
              gets the identical banner, and has no way to tell the second
              attempt from the first.
            */}
            {busy
              ? 'Generating…'
              : notGenerated
                ? `Try generating ${selected.size} test${selected.size === 1 ? '' : 's'} again`
                : `Generate ${selected.size} test${selected.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      )}
    </Page>
  );
}
