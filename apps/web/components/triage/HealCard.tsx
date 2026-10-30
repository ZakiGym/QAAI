'use client';

import Link from 'next/link';
import type { Heal } from '../../lib/api';
import { cn } from '../../lib/cn';
import { relativeTime } from '../ui';
import { Badge } from '../ui/layout';
import { Button } from '../ui/Button';
import { DiffRows } from './DiffRows';
import {
  appliesImmediately,
  claimLine,
  healClaim,
  isRetirement,
  riskOf,
  type Tone,
} from './heal-risk';

/**
 * One heal proposal, graded by risk.
 *
 * Risk is the most important thing on the card, because the levels are
 * genuinely different decisions: a renamed selector is a rubber stamp, a
 * changed assertion means the test now checks something different, a structural
 * change deserves reading like a colleague's pull request — and a RETIREMENT is
 * not a code change at all, it switches the test off. So it decides the chip
 * colour, the words on the button, whether Apply is the primary action, and
 * whether applying asks first.
 *
 * The vocabulary itself lives in heal-risk.ts, where a test can reach it.
 */

export { RISK, riskOf, appliesImmediately } from './heal-risk';

const STATE_LABEL: Record<string, string> = {
  PROPOSED: 'Awaiting review',
  APPROVED: 'Approved',
  APPLIED: 'Applied',
  AUTO_APPLIED: 'Auto-applied',
  REJECTED: 'Rejected',
  /** A newer proposal for the same test won; this one was never decided. */
  SUPERSEDED: 'Superseded by a newer proposal',
};

/** Badge tones, by the tone name the risk/verification vocabulary uses. */
const VERIFY_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-dim',
  accent: 'text-accent',
  pass: 'text-pass',
  fail: 'text-fail',
  flake: 'text-flake',
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
  /*
   * A retirement has no diff by construction, so the diff view's honest empty
   * state ("the proposal arrived without a diff") would read as a broken
   * proposal. Its evidence is the server's own review sentence instead.
   */
  const retirement = isRetirement(heal) || heal.preview.kind === 'RETIREMENT';

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

      {retirement ? (
        /* No diff exists to show. What approval does, and which check the
           server could and could not run, is the whole of the evidence. */
        <>
          {heal.preview.review && (
            <p className="border-fail/40 text-ink mt-3 rounded-md border bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)] px-2.5 py-2 text-[12.5px] leading-relaxed">
              {heal.preview.review}
            </p>
          )}
          {heal.preview.checks && (
            <p className="text-ink-faint text-micro mt-2">{heal.preview.checks}</p>
          )}
        </>
      ) : (
        <>
          <DiffRows diff={heal.diff} />

          {!stale && (heal.preview.fuzz ?? 0) > 0 && (
            <p className="text-ink-faint text-micro mt-2">
              The patch needs <span className="tabular-nums">{heal.preview.fuzz}</span> line(s) of
              fuzz to fit — check the result.
            </p>
          )}
        </>
      )}

      <Verification heal={heal} />

      {heal.state === 'PROPOSED' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant={immediate ? 'primary' : 'secondary'}
            onClick={onApply}
            disabled={frozen || stale}
            loading={busy}
            title={stale ? 'The diff no longer applies to this test' : undefined}
          >
            {/* The button says what it does. `Apply` on a retirement was the
                last thing a reviewer read before switching a test off. */}
            {immediate ? risk.action : `${risk.action} — asks to confirm`}
          </Button>
          <Button variant="ghost" onClick={onReject} disabled={frozen} className="hover:text-fail">
            Reject
          </Button>
          <span className="text-ink-faint font-mono text-[10.5px]">
            {retirement
              ? `disables ${heal.test.name} · the code stays in your repository`
              : `writes to ${heal.test.filePath} · version recorded first`}
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

/**
 * "We applied this heal and then proved the test passes."
 *
 * The single most load-bearing sentence this feature produces, and it is THREE
 * FACTS, not one.
 *
 * ── WHAT IT USED TO BE DRIVEN OFF, AND WHY THAT WAS A LIE ───────────────────
 *
 * One boolean, `verification.claimsFixed`. With it false, three different
 * things rendered as the same pixel: APPLIED-AND-STILL-RED,
 * APPLIED-AND-NOBODY-COULD-LOOK and APPLIED-AND-NOTHING-HAS-RUN-YET. A
 * reviewer reading this card could not tell a fix that failed from a fix
 * nobody checked, and the second is the one that leaves a red test on the
 * board looking handled.
 *
 * `healClaim` is the vocabulary now, over the server's own
 * `healVerificationDisplay`: `measured`, `fixed` and `unverified`, one fact per
 * field. Three rules this block follows, all three the difference between it
 * and a lie:
 *
 *  · A NULL state renders NOTHING (unless the server attached a note). Null
 *    means nobody applied this proposal, so nothing was verified — it is not a
 *    failed verification and must not be coloured like one.
 *  · the PASS colour needs BOTH `fixed` and the server's own `claimsFixed`.
 *    See `verifyTone`.
 *  · A state this build does not recognise says so (see `verifyMeta`) rather
 *    than being read as "not verified".
 */
function Verification({ heal }: { heal: Heal }) {
  const { verification } = heal;
  const claim = healClaim(heal);
  const meta = claim.meta;
  if (!meta && !verification.note) return null;
  const tone = claim.tone;
  const line = claimLine(claim);

  return (
    <div className="border-line mt-3 border-t pt-2.5">
      <p className="text-micro">
        <span className={cn('font-mono font-semibold', VERIFY_TEXT[tone])}>
          {/* "No verification recorded" and not "not verified": the second
              reads as a check that ran and came back negative. */}
          {meta ? meta.word : 'No verification recorded'}
        </span>
        {/*
          THE THREE FACTS, SAID OUT LOUD BESIDE THE LABEL — and composed in
          heal-risk.ts rather than here, because this repository has no React
          render tooling and a sentence built inside the JSX is the one thing
          nothing can assert about. `claimLine` is tested; this is a projection.
        */}
        {line && <span className="text-ink-faint"> · {line}</span>}
        {verification.at && (
          <span className="text-ink-faint"> · {relativeTime(verification.at)}</span>
        )}
        {verification.runId && (
          <>
            <span className="text-ink-faint"> · </span>
            <Link
              href={`/runs/${verification.runId}`}
              className="text-accent hover:underline"
              title="The run that checked this heal"
            >
              open the verifying run →
            </Link>
          </>
        )}
      </p>
      {verification.note && (
        <p className="text-ink-dim text-micro mt-1 leading-relaxed">{verification.note}</p>
      )}
      {/*
        WHERE THIS LEFT THE PRODUCT. A heal that only exists in QAAI is a fix a
        reviewer has to come here to discover, which is not how a reviewer works
        — so when a pull request was opened, the card says so and links to it.

        ABSENT, not "not opened": a heal with no pull request renders nothing at
        all rather than a line implying somebody should have opened one. Pull
        requests are an opt-in, per-project setting, and a card nagging about a
        feature the customer deliberately left off is a card they stop reading.
      */}
      {heal.pullRequest && (
        <p className="text-micro mt-1">
          <a
            href={heal.pullRequest.url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
            title="The pull request QAAI opened for this fix"
          >
            open the pull request →
          </a>
        </p>
      )}
    </div>
  );
}
