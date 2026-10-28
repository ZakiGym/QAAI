'use client';

/**
 * Review the changes QAAI wants to make to tests that already exist.
 *
 * ── WHY THIS SCREEN EXISTS ──────────────────────────────────────────────────
 *
 * `suite-health.ts` has named duplicate clusters and weak assertions since it
 * was written and NOTHING COULD ACT ON THEM: the suite only ever grew. A
 * proposal nobody can review is the same as no proposal, so this is the door.
 *
 * ── CORRECTNESS ONLY, DELIBERATELY ──────────────────────────────────────────
 *
 * No new visual language, no new design system, no restyle: every token and
 * every primitive here is one the cockpit already uses (`Page`, `PageHeader`,
 * `Button`, `EmptyState`, `border-line`, `text-ink-dim`, `text-flake`). The
 * owner is designing this section later and asked for correctness-only UI work.
 * What this screen is responsible for is the two things a REVIEWER cannot do
 * without:
 *
 *   1. SEEING WHAT WOULD CHANGE. Every artifact, before and after, by path.
 *   2. TELLING A PROPOSED EDIT TO THEIR OWN FILE FROM A WRITE TO OURS. A
 *      `PROPOSED_EDIT` can never be written — only approved by the person whose
 *      file it is — and it is marked with a word and the cockpit's own amber border
 *      rather than being left to look identical to a file QAAI owns. Both the
 *      disposition and the recorded ownership are shown, because they answer
 *      different questions: what is being asked for, and what the ledger says.
 *
 * Nothing here decides whether a change may be applied. `applyable` comes from
 * the API's own `APPLYABLE_STATES`, whose only `true` key is APPROVED; a screen
 * that computed it would be a second opinion about a write to somebody's
 * repository.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  decideSuiteChange,
  proposeSuiteChanges,
  suiteChanges,
  type ProposedArtifactView,
  type SuiteChangeProposalView,
  type SuiteChangeProposeResult,
} from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Page, PageHeader } from '../../../components/ui/layout';
import { useProject } from '../../../components/shell/ProjectContext';

/**
 * How a disposition reads to a reviewer, and whether QAAI may write it at all.
 *
 * A `Record` over the whole union rather than a lookup with a fallback: a fourth
 * disposition would otherwise render as `undefined` on the one row where getting
 * it wrong overwrites somebody's file.
 */
const DISPOSITION: Record<
  ProposedArtifactView['disposition'],
  { label: string; writable: boolean; why: string }
> = {
  NEW: {
    label: 'new file',
    writable: true,
    why: 'Nothing is at this path, so writing it destroys nothing.',
  },
  UPDATE_OWNED: {
    label: 'updates a file QAAI owns',
    writable: true,
    why: 'QAAI wrote this file and the bytes on disk are still the bytes QAAI wrote.',
  },
  PROPOSED_EDIT: {
    label: 'PROPOSED EDIT TO YOUR FILE',
    writable: false,
    why: 'QAAI does not own this file, so it can never write it. This is a request, and only you can accept it.',
  },
};

function Artifact({
  artifact,
  before,
}: {
  artifact: ProposedArtifactView;
  /** The same path as it stands today, when the proposal replaces something. */
  before: ProposedArtifactView | undefined;
}) {
  const disposition = DISPOSITION[artifact.disposition];
  return (
    <div
      className={
        // The ONE visual distinction this screen owes: a change to a file QAAI
        // does not own is bordered and labelled, not left to look like ours.
        disposition.writable
          ? 'border-line mt-3 rounded-md border'
          : 'border-flake/40 bg-[color-mix(in_srgb,var(--color-flake)_8%,transparent)] mt-3 rounded-md border'
      }
    >
      <div className="border-line/60 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2">
        <span className="font-mono text-[11.5px]">{artifact.path}</span>
        <span className="text-ink-faint text-micro tracking-wide uppercase">{artifact.role}</span>
        <span
          className={
            disposition.writable
              ? 'text-ink-dim text-micro tracking-wide uppercase'
              : 'text-flake text-micro font-semibold tracking-wide uppercase'
          }
        >
          {disposition.label}
        </span>
        <span className="text-ink-faint text-micro tracking-wide uppercase">
          ledger says {artifact.ownership}
        </span>
      </div>
      <p className="text-ink-dim px-3 pt-2 text-[11.5px] leading-relaxed">{disposition.why}</p>
      <p className="text-ink-dim px-3 pt-1 pb-2 text-[11.5px] leading-relaxed">{artifact.why}</p>
      {before && (
        <div className="px-3 pb-2">
          <p className="text-ink-faint text-micro tracking-wide uppercase">as it is today</p>
          <pre className="border-line/60 mt-1 max-h-48 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
            {before.content}
          </pre>
        </div>
      )}
      <div className="px-3 pb-3">
        <p className="text-ink-faint text-micro tracking-wide uppercase">
          {before ? 'as it would be' : 'what would be written'}
        </p>
        <pre className="border-line/60 mt-1 max-h-96 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
          {artifact.content}
        </pre>
      </div>
    </div>
  );
}

function Proposal({
  proposal,
  onDecided,
}: {
  proposal: SuiteChangeProposalView;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const beforeByPath = new Map(proposal.before.artifacts.map((a) => [a.path, a]));

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setBusy(decision);
    setError(null);
    try {
      await decideSuiteChange(proposal.id, decision);
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that decision.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="border-line mb-8 rounded-md border p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-body-sm min-w-0 flex-1 font-semibold">{proposal.title}</h2>
        <span className="text-ink-faint text-micro font-mono tracking-wide uppercase">
          {proposal.kind}
        </span>
        <span className="text-ink-faint text-micro tracking-wide uppercase">{proposal.state}</span>
      </header>

      <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">{proposal.rationale}</p>

      {/*
       * The review bar, stated rather than implied. A change that alters what
       * the suite CHECKS is a different kind of decision from one that only
       * moves code around, and `altersBehaviour` is read from the API so this
       * line and the apply path cannot disagree about it.
       */}
      <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">
        {proposal.altersBehaviour
          ? 'This changes what the suite checks, not only how it is written. Read every assertion in the diff before approving.'
          : 'This moves code without changing what the suite checks.'}
      </p>

      {/*
       * THE BLAST RADIUS, DISCLOSED BY THE PRODUCER. An empty dependent list on
       * a change to a shared file is either a file nothing imports or a radius
       * nobody computed, so the count is printed either way rather than the
       * section being hidden when it is zero.
       */}
      <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">
        {proposal.dependentPaths.length === 0
          ? 'No other file in the ledger imports anything this changes.'
          : `${proposal.dependentPaths.length} other file(s) import something this changes: ${proposal.dependentPaths.join(', ')}.`}
      </p>

      {proposal.blockedReason && (
        <p className="text-flake mt-2 text-[11.5px] leading-relaxed">
          Cannot be applied as written: {proposal.blockedReason}
        </p>
      )}

      {proposal.after.artifacts.map((artifact) => (
        <Artifact
          key={artifact.path}
          artifact={artifact}
          before={beforeByPath.get(artifact.path)}
        />
      ))}

      {/*
       * Approving is a decision; applying is a write. They are deliberately two
       * steps, so this button says what it does.
       */}
      {proposal.state === 'PROPOSED' && (
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'APPROVED'}
            onClick={() => void decide('APPROVED')}
          >
            Approve (does not apply it)
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'REJECTED'}
            onClick={() => void decide('REJECTED')}
          >
            Reject
          </Button>
        </div>
      )}
      {proposal.state !== 'PROPOSED' && (
        <p className="text-ink-faint mt-4 text-[11.5px]">
          {proposal.applyable
            ? 'Approved. Nothing has been written to your repository yet.'
            : 'Decided. Kept on record rather than deleted, so the trail of what was approved survives.'}
        </p>
      )}

      {error && <p className="text-fail mt-2 text-[11.5px]">{error}</p>}
    </article>
  );
}

export default function SuiteChangesPage() {
  const { projectId } = useProject();
  const [proposals, setProposals] = useState<SuiteChangeProposalView[]>([]);
  const [why, setWhy] = useState<string | null>(null);
  const [scan, setScan] = useState<SuiteChangeProposeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await suiteChanges(projectId);
      setProposals(list.proposals);
      setWhy(list.why);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the proposals.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const propose = async () => {
    if (!projectId) return;
    setProposing(true);
    setError(null);
    try {
      setScan(await proposeSuiteChanges(projectId));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not look for changes.');
    } finally {
      setProposing(false);
    }
  };

  if (!projectId) {
    return (
      <Page width="wide">
        <EmptyState
          title="Choose a project"
          body="Suite-change proposals are per project — pick one in the sidebar."
        />
      </Page>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Suite changes"
        size="sm"
        subtitle="Changes QAAI wants to make to tests that already exist. Nothing here is applied until you approve it, and nothing here deletes a test."
        actions={
          <Button variant="secondary" size="sm" loading={proposing} onClick={() => void propose()}>
            Look for changes
          </Button>
        }
      />

      {error && <p className="text-fail mb-4 text-[11.5px]">{error}</p>}

      {/*
       * WHAT THE LAST SCAN DID AND DID NOT DO. Every one of these is a cap, a
       * refusal or a capability that BIT, and printing the proposal list without
       * them would make "two proposals" read as "two things worth changing in
       * your whole suite".
       */}
      {scan && (
        <section className="border-line mb-8 rounded-md border p-4">
          <p className="text-ink-faint text-micro tracking-wide uppercase">last scan</p>
          <p className="text-ink-dim mt-1 text-[11.5px] leading-relaxed">
            Read {scan.testsRead} test(s). Proposed {scan.proposed.length}.
            {scan.duplicateScanComplete
              ? ''
              : ' The duplicate scan did not complete, so its clusters are a floor rather than a total and no merge was proposed from it.'}
          </p>
          {scan.declined.length > 0 && (
            <ul className="text-ink-dim mt-2 space-y-1 text-[11.5px] leading-relaxed">
              {scan.declined.map((entry, index) => (
                <li key={`${entry.operation}-${index}`}>
                  <span className="text-ink-faint font-mono text-[11px]">{entry.operation}</span>{' '}
                  {entry.why}
                </li>
              ))}
            </ul>
          )}
          {scan.refused.length > 0 && (
            <ul className="text-ink-dim mt-2 space-y-1 text-[11.5px] leading-relaxed">
              {scan.refused.map((entry, index) => (
                <li key={`refused-${index}`}>{entry.problems.join(' ')}</li>
              ))}
            </ul>
          )}
          {scan.needsVerification > 0 && (
            <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">
              {scan.needsVerification} weak assertion(s) could be strengthened and were not
              proposed: a stronger assertion has to be RUN before anyone may call it a
              strengthening, and nothing has run it.
            </p>
          )}
          <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">
            {scan.extractionUnavailable}
          </p>
          {(scan.omitted.merges > 0 || scan.omitted.strengthenings > 0) && (
            <p className="text-ink-dim mt-2 text-[11.5px] leading-relaxed">
              {scan.omitted.merges} merge(s) and {scan.omitted.strengthenings} strengthening(s)
              beyond the per-scan cap were not offered, so this list is a page of the findings and
              not all of them.
            </p>
          )}
        </section>
      )}

      {loading && proposals.length === 0 && (
        <p className="text-ink-faint text-[11.5px]">Loading…</p>
      )}

      {!loading && proposals.length === 0 && (
        <EmptyState
          title="No proposed changes"
          body="QAAI has not proposed any change to your existing tests. Press “Look for changes” to read the suite — an empty result after that means it looked and found nothing worth asking for, which is a different answer from never having looked."
          action={{ label: 'Look for changes', onClick: () => void propose() }}
        />
      )}

      {proposals.map((proposal) => (
        <Proposal key={proposal.id} proposal={proposal} onDecided={() => void load()} />
      ))}

      {why && proposals.length > 0 && (
        <p className="text-ink-faint mt-2 text-[11.5px] leading-relaxed">{why}</p>
      )}
    </Page>
  );
}
