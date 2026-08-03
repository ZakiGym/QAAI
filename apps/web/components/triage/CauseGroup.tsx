'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '../../lib/cn';
import { relativeTime } from '../ui';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';
import { Kbd } from './Kbd';
import {
  chipLabel,
  metaFor,
  OVERRIDES,
  type CauseGroup as Cause,
  type TriageVerdict,
  type VerdictKind,
} from './verdicts';

/**
 * One cause, and every failure that shares it.
 *
 * The queue used to be one row per failure, which is the shape of the data and
 * not the shape of the decision: when a shared dependency breaks, forty tests
 * fail for one reason and the answer to all forty is the same sentence. This is
 * that sentence, with the failures under it — and the group-level button is the
 * bulk decision, recorded by the server as N separate decisions.
 */

export type Action = 'accept' | 'override' | 'mute';

/** Shared by the page (which sets it) and this component (which reads it). */
export function busyKey(scope: string, action: Action, overrideTo?: string): string {
  return `${scope}:${overrideTo ?? action}`;
}

export interface OwnerRow {
  testId: string;
  owner: { kind: 'USER' | 'TEAM'; id: string; label: string } | null;
  reason: string | null;
}

export interface CauseGroupProps {
  group: Cause;
  /** The j/k cursor is on this group: its decision is what A/F/I/M will hit. */
  focused: boolean;
  owners: Map<string, OwnerRow>;
  /** Tests the healer has actually written a proposal for. */
  healedTestIds: Set<string>;
  /** Which verdict's evidence is open, if any. */
  openId: string | null;
  onToggleEvidence: (verdictId: string) => void;
  /** Clicking anywhere in the group moves the keyboard cursor here. */
  onFocus: () => void;
  onDecideGroup: (action: Action, overrideTo?: VerdictKind) => void;
  onDecideOne: (verdict: TriageVerdict, action: Action, overrideTo?: VerdictKind) => void;
  /** The action currently in flight, so only its button spins. */
  busy: string | null;
}

export function CauseGroup({
  group,
  focused,
  owners,
  healedTestIds,
  openId,
  onToggleEvidence,
  onFocus,
  onDecideGroup,
  onDecideOne,
  busy,
}: CauseGroupProps) {
  const single = group.members.length === 1 ? group.members[0]! : null;
  const pending = group.members.filter((m) => m.reviewState === 'PENDING');
  const meta = metaFor(group.verdict);
  const agreeKey = busyKey(group.key, 'accept');

  /*
   * The override menu for a cause of ONE. Member rows carry their own
   * `override ▾`, but a single has no member rows — and without this its only
   * mouse affordance was Agree. The keyboard could still override (f/i/m act on
   * the focused group), which made it worse, not better: a control that exists
   * for keyboard users and simply isn't there for mouse users is the kind of
   * gap nobody reports, they just conclude the product can only rubber-stamp.
   */
  const [singleMenu, setSingleMenu] = useState(false);

  /*
   * Ownership, only when it is true of the whole group. A cause whose failures
   * belong to two squads has no one owner, and printing one of them would be a
   * routing instruction that sends the work to the wrong place.
   */
  const ownerLabels = new Set(
    group.members.map((m) => owners.get(m.testResult.test.id)?.owner?.label ?? ''),
  );
  const owner = ownerLabels.size === 1 ? [...ownerLabels][0] : '';

  return (
    // Hairline top, no card. Twenty causes stacked in boxes is twenty borders
    // nobody reads; the rule plus the gap is what separates them.
    <section
      className="border-line border-t pt-5"
      onMouseDown={onFocus}
      aria-label={`${group.label} — ${group.members.length} ${group.members.length === 1 ? 'failure' : 'failures'}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {group.members.length > 1 && (
              <span className="text-fail shrink-0 font-mono text-[12px] font-semibold tabular-nums">
                ×{group.members.length}
              </span>
            )}
            {single ? (
              // The heading is the affordance: there is no member row to click,
              // so the failure's own name opens its evidence.
              <h2 className="font-display min-w-0 text-[18px] leading-[1.3] font-semibold">
                <button
                  type="button"
                  onClick={() => onToggleEvidence(single.id)}
                  aria-expanded={openId === single.id}
                  className="hover:text-ink-dim text-left transition-colors"
                >
                  {group.label}
                </button>
              </h2>
            ) : (
              <h2 className="font-display min-w-0 text-[18px] leading-[1.3] font-semibold">
                {group.label}
              </h2>
            )}
            <Badge tone={meta.tone} tint className="shrink-0">
              {chipLabel(group.verdict)} · <span className="tabular-nums">{group.confidence.toFixed(2)}</span>
            </Badge>
            {!group.unanimous && (
              /* The chip is the majority call. Saying so is the difference
                 between a summary and a claim the data does not support. */
              <span className="text-ink-faint font-mono text-meta">
                mixed —{' '}
                <span className="tabular-nums">
                  {group.members.filter((m) => m.verdict === group.verdict).length}
                </span>{' '}
                of <span className="tabular-nums">{group.members.length}</span>
              </span>
            )}
          </div>

          {/* Serif italic: the model wrote this sentence, and the UI says so by
              setting it apart from everything the product wrote. */}
          <p className="font-display text-ink-dim mt-[7px] text-[14px] leading-[1.5] italic">
            {group.explanation}
          </p>

          {single && (
            <p className="text-ink-faint mt-2 font-mono text-[10.5px]">
              <span title={single.testResult.test.filePath}>
                {basename(single.testResult.test.filePath)}
              </span>{' '}
              ·{' '}
              <Link
                href={`/runs/${single.testResult.runId}`}
                className="hover:text-accent transition-colors"
              >
                {single.testResult.runId.slice(0, 8)}
              </Link>{' '}
              · <span className="tabular-nums">{relativeTime(single.createdAt)}</span>
              {owner && ` · owned by ${owner}`}
              {single.reviewState !== 'PENDING' && ` · ${single.reviewState.toLowerCase()}`}
            </p>
          )}
        </div>

        {pending.length > 0 && (
          <div className="flex shrink-0 items-center gap-3">
            <Button
              variant={focused ? 'primary' : 'secondary'}
              onClick={() => onDecideGroup('accept')}
              disabled={busy !== null}
              loading={busy === agreeKey}
            >
              {/* Only on the focused group: [A] is true of exactly one button on
                  the page at a time, and printing it on all of them would be a
                  promise the keyboard does not keep. */}
              {focused && <Kbd>A</Kbd>}
              {pending.length > 1 ? `Agree all ${pending.length}` : 'Agree'}
            </Button>

            {single && (
              <span className="relative font-mono text-[10.5px]">
                <button
                  type="button"
                  onClick={() => setSingleMenu((o) => !o)}
                  disabled={busy !== null}
                  aria-expanded={singleMenu}
                  aria-haspopup="menu"
                  className="text-ink-faint hover:text-ink transition-colors disabled:opacity-50"
                >
                  override ▾
                </button>
                {singleMenu && (
                  <OverrideMenu
                    current={single.verdict}
                    onPick={(to) => {
                      setSingleMenu(false);
                      onDecideOne(single, 'override', to);
                    }}
                    onMute={() => {
                      setSingleMenu(false);
                      onDecideOne(single, 'mute');
                    }}
                    onClose={() => setSingleMenu(false)}
                  />
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {!single && (
        <div className="mt-3.5">
          {group.members.map((member) => (
            <MemberRow
              key={member.id}
              verdict={member}
              owner={owners.get(member.testResult.test.id)?.owner?.label ?? null}
              healed={healedTestIds.has(member.testResult.test.id)}
              open={openId === member.id}
              onToggleEvidence={() => onToggleEvidence(member.id)}
              onDecide={(action, overrideTo) => onDecideOne(member, action, overrideTo)}
              busy={busy}
            />
          ))}
        </div>
      )}

      {single && openId === single.id && (
        <Evidence
          verdict={single}
          owner={owner || null}
          healed={healedTestIds.has(single.testResult.test.id)}
        />
      )}

      {!single && (
        /* What the server will actually record, printed next to the button that
           does it. A bulk action that quietly logs itself as one decision is one
           nobody should trust. */
        <p className="text-ink-faint mt-2.5 font-mono text-[10px]">
          {owner && `owned by ${owner} · `}
          {pending.length > 0
            ? `recorded as ${pending.length} separate ${pending.length === 1 ? 'decision' : 'decisions'} · reversible`
            : 'every failure here has been reviewed'}
        </p>
      )}
    </section>
  );
}

function MemberRow({
  verdict,
  owner,
  healed,
  open,
  onToggleEvidence,
  onDecide,
  busy,
}: {
  verdict: TriageVerdict;
  owner: string | null;
  healed: boolean;
  open: boolean;
  onToggleEvidence: () => void;
  onDecide: (action: Action, overrideTo?: VerdictKind) => void;
  busy: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const reviewed = verdict.reviewState !== 'PENDING';

  return (
    <div>
      <div
        className={cn(
          '-mx-2.5 flex items-center gap-3 rounded-md px-2.5 py-[9px] transition-colors',
          open ? 'bg-surface-1' : 'hover:bg-surface-1',
        )}
      >
        <button
          type="button"
          onClick={onToggleEvidence}
          aria-expanded={open}
          className={cn(
            'text-body-sm min-w-0 flex-1 truncate text-left',
            reviewed && 'text-ink-faint',
          )}
        >
          {verdict.testResult.test.name}
        </button>

        <span className="text-ink-faint shrink-0 font-mono text-[10.5px]">
          <span title={verdict.testResult.test.filePath}>
            {basename(verdict.testResult.test.filePath)}
          </span>{' '}
          ·{' '}
          <Link
            href={`/runs/${verdict.testResult.runId}`}
            className="hover:text-accent transition-colors"
          >
            {verdict.testResult.runId.slice(0, 8)}
          </Link>{' '}
          · <span className="tabular-nums">{relativeTime(verdict.createdAt)}</span>
          {owner && <span className="hidden lg:inline"> · {owner}</span>}
        </span>

        {reviewed ? (
          <span className="text-ink-faint shrink-0 font-mono text-[10.5px]">
            {verdict.reviewState.toLowerCase()}
          </span>
        ) : (
          <span className="relative flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
            <button
              type="button"
              onClick={() => onDecide('accept')}
              disabled={busy !== null}
              className="text-accent transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              agree
            </button>
            <span className="text-ink-faint">·</span>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={busy !== null}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="text-ink-faint hover:text-ink transition-colors disabled:opacity-50"
            >
              override ▾
            </button>
            {menuOpen && (
              <OverrideMenu
                current={verdict.verdict}
                onPick={(to) => {
                  setMenuOpen(false);
                  onDecide('override', to);
                }}
                onMute={() => {
                  setMenuOpen(false);
                  onDecide('mute');
                }}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </span>
        )}
      </div>

      {open && <Evidence verdict={verdict} owner={owner} healed={healed} />}
    </div>
  );
}

/** The other three calls, plus mute. Opened from one row, applies to one row. */
function OverrideMenu({
  current,
  onPick,
  onMute,
  onClose,
}: {
  current: VerdictKind;
  onPick: (verdict: VerdictKind) => void;
  onMute: () => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* Click anywhere else to dismiss. Not focusable, so it never appears in
          the tab order between the menu and the rest of the page. */}
      <div className="fixed inset-0 z-10" aria-hidden="true" onMouseDown={onClose} />
      <div
        role="menu"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="border-line bg-surface-1 shadow-overlay absolute top-full right-0 z-20 mt-1.5 w-44 rounded-md border p-1"
      >
        {OVERRIDES.filter((option) => option !== current).map((option) => (
          <button
            key={option}
            type="button"
            role="menuitem"
            onClick={() => onPick(option)}
            className="text-body-sm hover:bg-surface-2 block w-full rounded-sm px-2 py-1.5 text-left font-sans"
          >
            {metaFor(option).label}
          </button>
        ))}
        <button
          type="button"
          role="menuitem"
          onClick={onMute}
          className="text-body-sm text-ink-dim hover:bg-surface-2 hover:text-ink border-line mt-1 block w-full rounded-sm border-t px-2 py-1.5 text-left font-sans"
        >
          Mute — never gates
        </button>
      </div>
    </>
  );
}

/**
 * What the agent looked at, and the two questions a decision actually rests on:
 * has this test always done this, and is there a fix waiting for it.
 */
function Evidence({
  verdict,
  owner,
  healed,
}: {
  verdict: TriageVerdict;
  owner: string | null;
  healed: boolean;
}) {
  const meta = metaFor(verdict.verdict);

  return (
    <div className="border-line bg-surface-1/50 -mx-2.5 mt-1 mb-2 rounded-lg border px-3.5 py-3">
      <p className="text-ink-faint text-micro mb-2.5 font-mono font-semibold tracking-[0.1em] uppercase">
        Evidence it used
      </p>

      {verdict.evidence.length === 0 ? (
        <p className="text-ink-faint text-micro">
          No screenshot, trace or console output was captured for this failure.
        </p>
      ) : (
        <div className="divide-line divide-y">
          {verdict.evidence.map((item, i) => (
            <div key={i} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-baseline gap-2">
                <Badge>{item.kind}</Badge>
                <span className="text-ink-faint truncate font-mono text-meta">{item.ref}</span>
              </div>
              <p className="text-ink-dim mt-1 text-[12px] leading-relaxed">{item.detail}</p>
            </div>
          ))}
        </div>
      )}

      <p className="text-ink-faint text-micro mt-3">
        {meta.blurb}
        {/* Only when a proposal exists. This blurb used to promise a fix for
            every intended change and link to a queue that filtered down to
            nothing — offering a fix and then showing an empty screen is worse
            than not offering one. */}
        {verdict.verdict === 'INTENDED_CHANGE' &&
          (healed ? (
            <>
              {' '}
              <Link
                href={`/heals?test=${verdict.testResult.test.id}`}
                className="text-accent hover:underline"
              >
                Review the proposed fix for this test →
              </Link>
            </>
          ) : (
            <>
              {' '}
              The healer has not proposed a fix for this one — update the test in the editor.{' '}
              <Link
                href={`/editor?test=${verdict.testResult.test.id}`}
                className="text-accent hover:underline"
              >
                Open it →
              </Link>
            </>
          ))}
      </p>

      <p className="text-ink-faint text-micro mt-2">
        Decided by {verdict.model}.{' '}
        <span className="tabular-nums">{relativeTime(verdict.createdAt)}</span>
        {owner && ` · owned by ${owner}`}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
        <Link href={`/runs/${verdict.testResult.runId}`} className="text-accent hover:underline">
          Open the run →
        </Link>
        {/*
          The question every triage decision rests on: is this test always like
          this? FLAKE on a test that has failed forty times running is a
          different call from the same verdict on one that never fails.
        */}
        <Link
          href={`/tests/${verdict.testResult.test.id}`}
          title="Pass rate, flake rate, quarantine state, and when it started failing"
          className="text-ink-faint hover:text-ink transition-colors"
        >
          Has it always done this? →
        </Link>
      </div>
    </div>
  );
}

/** Rows are tight; the directory is context, the file is the identifier. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
