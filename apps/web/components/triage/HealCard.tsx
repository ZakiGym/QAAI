'use client';

import Link from 'next/link';
import type { Heal } from '../../lib/api';
import { cn } from '../../lib/cn';
import { relativeTime } from '../ui';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';
import { DiffRows } from './DiffRows';

/**
 * One heal proposal, graded by risk.
 *
 * Risk is the most important thing on the card, because the three levels are
 * genuinely different decisions: a renamed selector is a rubber stamp, a
 * changed assertion means the test now checks something different, and a
 * structural change deserves reading like a colleague's pull request. So it
 * decides the chip colour, whether Apply is the primary action, and whether
 * applying asks first.
 */

type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';

export const RISK: Record<string, { label: string; blurb: string; tone: Tone }> = {
  SELECTOR_ONLY: {
    label: 'Selector only',
    blurb:
      'Only a locator changed. No assertion was touched, so the test still checks the same thing.',
    tone: 'pass',
  },
  ASSERTION_CHANGE: {
    label: 'Assertion change',
    blurb:
      'An expected value changed — read this one. After applying, the test checks something different than before.',
    tone: 'flake',
  },
  STRUCTURAL: {
    label: 'Structural',
    blurb:
      'Steps were added, removed, or reordered. Review it as you would a colleague’s pull request.',
    tone: 'fail',
  },
};

export const riskOf = (level: string) => RISK[level] ?? RISK.STRUCTURAL!;

/** Applying this one needs no second thought — and so gets no second dialog. */
export const appliesImmediately = (heal: Heal) => heal.riskLevel === 'SELECTOR_ONLY';

const STATE_LABEL: Record<string, string> = {
  PROPOSED: 'Awaiting review',
  APPROVED: 'Approved',
  APPLIED: 'Applied',
  AUTO_APPLIED: 'Auto-applied',
  REJECTED: 'Rejected',
};

export interface HealCardProps {
  heal: Heal;
  /** Arrived here from a `?test=` link — scrolled to and marked. */
  focused: boolean;
  busy: boolean;
  /** Any decision in flight, anywhere on the page. */
  frozen: boolean;
  onApply: () => void;
  onReject: () => void;
}

export function HealCard({ heal, focused, busy, frozen, onApply, onReject }: HealCardProps) {
  const risk = riskOf(heal.riskLevel);
  const immediate = appliesImmediately(heal);
  const stale = !heal.preview.applies;

  return (
    <section
      className={cn(
        'rounded-lg border px-[18px] py-4',
        // The low-risk proposal is the one you can act on without reading the
        // file, so it is the one that gets the raised surface and the primary
        // button. Weight follows what the reader is being asked to do.
        immediate ? 'border-line-strong bg-surface-1' : 'border-line',
        focused && 'ring-accent/40 ring-1',
      )}
      aria-label={`${risk.label} proposal for ${heal.test.name}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Badge tone={risk.tone} tint className="shrink-0">
          {risk.label.toUpperCase()} ·{' '}
          <span className="tabular-nums">{heal.confidence.toFixed(2)}</span>
        </Badge>
        <h2 className="font-display min-w-0 text-[17px] leading-[1.3] font-semibold">
          {heal.test.name}
        </h2>
        <span className="text-ink-faint shrink-0 font-mono text-[10.5px]">
          <Link
            href={`/editor?test=${heal.test.id}`}
            title={heal.test.filePath}
            className="hover:text-accent transition-colors"
          >
            {heal.test.filePath.slice(heal.test.filePath.lastIndexOf('/') + 1)}
          </Link>{' '}
          · <span className="tabular-nums">{relativeTime(heal.createdAt)}</span>
        </span>
        {heal.state !== 'PROPOSED' && (
          <Badge className="shrink-0">{STATE_LABEL[heal.state] ?? heal.state}</Badge>
        )}
      </div>

      {/* Serif italic: the healer wrote this sentence. */}
      <p className="font-display text-ink-dim mt-[7px] text-[14px] leading-[1.5] italic">
        {heal.explanation}
      </p>
      <p className="text-ink-faint text-micro mt-1.5">{risk.blurb}</p>

      {stale && (
        /* The same diff, with a warning over it. The old screen swapped the
           whole view for a raw <pre> here, which made the hardest case to read
           the one drawn in the least readable way. */
        <p
          role="status"
          className="border-flake/40 text-flake mt-3 rounded-md border bg-[color-mix(in_srgb,var(--color-flake)_10%,transparent)] px-2.5 py-2 text-[11.5px]"
        >
          {heal.preview.reason ?? 'This diff no longer applies to the test as it stands.'} It is
          shown below as the healer wrote it — the file has moved on since.
        </p>
      )}

      <DiffRows diff={heal.diff} />

      {!stale && (heal.preview.fuzz ?? 0) > 0 && (
        <p className="text-ink-faint text-micro mt-2">
          The patch needs <span className="tabular-nums">{heal.preview.fuzz}</span> line(s) of fuzz
          to fit — check the result.
        </p>
      )}

      {heal.state === 'PROPOSED' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant={immediate ? 'primary' : 'secondary'}
            onClick={onApply}
            disabled={frozen || stale}
            loading={busy}
            title={stale ? 'The diff no longer applies to this test' : undefined}
          >
            {immediate ? 'Apply' : 'Apply — asks to confirm'}
          </Button>
          <Button variant="ghost" onClick={onReject} disabled={frozen} className="hover:text-fail">
            Reject
          </Button>
          <span className="text-ink-faint font-mono text-[10.5px]">
            writes to {heal.test.filePath} · version recorded first
          </span>
        </div>
      ) : (
        <p className="text-ink-faint mt-3 font-mono text-[10.5px]">
          {(STATE_LABEL[heal.state] ?? heal.state).toLowerCase()} ·{' '}
          <Link href={`/editor?test=${heal.test.id}`} className="hover:text-accent">
            open the test →
          </Link>
        </p>
      )}
    </section>
  );
}
