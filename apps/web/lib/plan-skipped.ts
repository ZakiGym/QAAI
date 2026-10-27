/**
 * Grouping a plan's "deliberately skipped" list, because three different facts
 * were rendering as one grey list.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The type funnel in packages/agent/src/explorer.ts widened the deterministic
 * producer from two proposable test types to all nineteen minted ones, and the
 * honest half of that widening is the REFUSALS: for every type it did not
 * propose, the plan says which and why. That is up to thirty entries, and they
 * are not one kind of thing:
 *
 *   · EARNED and not storable — the application has the surface, and QAAI
 *     cannot hold a test of that type yet. OUR backlog, and the only group in
 *     the list anybody should act on.
 *   · NOT ENUMERATED — nobody looked. A hole in OUR crawl, with a remedy (run
 *     source analysis, connect the repository).
 *   · NOT APPLICABLE — we looked and this application does not have that
 *     surface. A finished answer that needs nobody.
 *
 * Rendered undifferentiated, thirty of those bury the two entries that actually
 * need reading ("Model-written test proposals", "Enumeration caveat") and the
 * one group that is actionable looks exactly like the twelve that are not. The
 * register's wording for the same rule on the runnability panel: a type
 * reported MISSING must be visually distinct from one that failed.
 *
 * ── WHY THIS MATCHES ON A SUFFIX, WHICH IS NOT WHAT I WOULD CHOOSE ──────────
 *
 * `testPlanSchema.skipped` is `{ what: string; why: string }` and nothing else,
 * so there is no typed field for the kind. Widening that wire shape is a schema
 * change with a stored-JSON migration behind it, and this change does not own
 * it. So the worker tags `what` with a declared suffix and this file is the
 * other half of that contract. Both halves are pinned by tests — in
 * apps/worker/src/processors/explore.funnel.test.ts and in ./plan-skipped.test
 * .ts — so the producer and the reader cannot drift apart silently, which is
 * the one real risk of a prose contract.
 *
 * NO NEW VISUAL LANGUAGE. This file returns GROUPS and nothing else: no colour,
 * no class, no icon. The page renders each group with the SectionLabel and list
 * markup it already uses — the only change is that there are three labelled
 * lists instead of one unlabelled one, in the order a reader should read them.
 */

/**
 * The suffixes the worker appends to `what`. The contract, in one place.
 *
 * ORDER IS THE READING ORDER, and it is the whole editorial decision in this
 * file: what somebody should do something about first, what is our own gap
 * second, and the finished answers last.
 */
export const SKIPPED_TAGS = [
  {
    /** Appended by `planFromCrawl` for a type in `TypeCoverageResult.unminted`. */
    suffix: ' — earned, not yet storable',
    group: 'EARNED_NOT_STORABLE',
    label: 'Earned by this application, not yet supported by QAAI',
    note: 'The enumeration found the surface each of these tests, and QAAI cannot store a test of that type yet. These are our backlog, not yours.',
  },
  {
    /** Appended for a `NOT_PROBED` verdict — nobody looked. */
    suffix: ' — not enumerated',
    group: 'NOT_ENUMERATED',
    label: 'Not enumerated — nobody looked yet',
    note: 'Whether this application needs these is UNKNOWN. That is a hole in our enumeration and NOT a finding about your application: connect the repository and run source analysis to answer them.',
  },
  {
    /** Appended for a `NOT_WARRANTED` verdict — we looked and it is not there. */
    suffix: ' — not applicable',
    group: 'NOT_APPLICABLE',
    label: 'Not applicable to this application',
    note: 'We looked and this application does not have the surface these tests cover. A finished answer — nothing to do.',
  },
] as const;

export type SkippedGroup = (typeof SKIPPED_TAGS)[number]['group'] | 'OTHER';

export interface SkippedEntry {
  readonly what: string;
  readonly why: string;
}

export interface SkippedSection {
  readonly group: SkippedGroup;
  /** The heading. Empty for OTHER, which keeps the list's original un-headed shape. */
  readonly label: string;
  /** One sentence under the heading. Empty for OTHER. */
  readonly note: string;
  /** `what` with the tag suffix removed, so the heading is not repeated per row. */
  readonly entries: readonly SkippedEntry[];
}

/**
 * Split a skipped list into its reading order.
 *
 * `OTHER` COMES FIRST AND IS NOT A LEFTOVER BUCKET. It holds every entry with
 * no tag — "Model-written test proposals", "Enumeration caveat", a gap ranked
 * below the plan budget — which are exactly the entries that predate the funnel
 * and the ones most likely to need reading. Burying them under thirty tagged
 * type verdicts would be the defect this function exists to fix, inverted.
 *
 * A group with no entries is OMITTED rather than rendered empty, because an
 * empty "Not applicable" heading reads as a claim that every type applies.
 *
 * Pure, total and order-preserving within each group: the worker's order is the
 * declaration order of `ANY_TEST_TYPES`, which is stable, so the rendered list
 * is stable too.
 */
export function groupSkipped(skipped: readonly SkippedEntry[]): SkippedSection[] {
  const other: SkippedEntry[] = [];
  const byGroup = new Map<string, SkippedEntry[]>();

  for (const entry of skipped) {
    const tag = SKIPPED_TAGS.find((candidate) => entry.what.endsWith(candidate.suffix));
    if (tag === undefined) {
      other.push(entry);
      continue;
    }
    const stripped = {
      what: entry.what.slice(0, entry.what.length - tag.suffix.length),
      why: entry.why,
    };
    const bucket = byGroup.get(tag.group);
    if (bucket) bucket.push(stripped);
    else byGroup.set(tag.group, [stripped]);
  }

  const sections: SkippedSection[] = [];
  if (other.length > 0) {
    sections.push({ group: 'OTHER', label: '', note: '', entries: other });
  }
  for (const tag of SKIPPED_TAGS) {
    const entries = byGroup.get(tag.group);
    if (entries === undefined || entries.length === 0) continue;
    sections.push({ group: tag.group, label: tag.label, note: tag.note, entries });
  }
  return sections;
}
