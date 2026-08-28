'use client';

import { SECTION_TABS_SLOT_ID } from './shell/AppShell';

/**
 * The masthead the five Tests screens share — one row, not three.
 *
 * It used to stack a mono eyebrow (`GROUND COFFEE CO. · 14 TESTS`), a display
 * heading (`Tests`), and the section tabs, and the editor then added a file
 * tab, a toolbar and a breadcrumb under that. Six bands and 229 pixels — a
 * third of a 720px window — before the first line of code, on the one screen
 * whose entire job is showing code.
 *
 * Two of the three were saying what the sidebar already says. The project name
 * and its test count are permanently on screen eighteen inches to the left, and
 * the nav there marks Tests as current, so the heading was the third thing on
 * screen naming a place the user had just chosen.
 *
 * What is left is the part nothing else carries: WHICH of the five Tests
 * screens you are on. The word `Tests` stays as a quiet anchor in front of the
 * tabs rather than a heading above them — it labels the strip, and a strip of
 * five bare verbs with no subject reads as a toolbar rather than a section.
 *
 * `detail` is gone as a prop, not merely unused: it invited each screen to
 * restate a count the sidebar draws.
 */
export function TestsHeader({ className }: { className?: string }) {
  return (
    <div
      className={
        className ?? 'border-line flex shrink-0 items-center gap-3 border-b px-6 py-2'
      }
    >
      <span className="text-ink-faint text-meta shrink-0 font-mono tracking-[0.1em] uppercase">
        Tests
      </span>
      {/*
        The portal target for the shell's tab strip. The strip is the shell's
        because it is derived from the route — that is what keeps Back working
        and every view linkable — but only a page knows where it belongs.
      */}
      <div id={SECTION_TABS_SLOT_ID} className="min-w-0 flex-1" />
    </div>
  );
}
