/**
 * Grouping the obligation audit's refusals, because FOUR different facts with
 * four different owners arrive as one array.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `auditObligationPolicy` in packages/agent/src/coverage.ts adjudicates a
 * project's type-obligation policy and was reached by nothing but its own test.
 * `GET /coverage/:projectId/obligations` is its first production reader, and it
 * returns `excluded[]` — every obligation that is NOT an ordinary closeable one
 * — as a flat list. Rendered flat, those are indistinguishable, and three of
 * the four are things nobody on this screen can act on:
 *
 *   · IMPOSSIBLE_FOR_AXIS — the policy names a test type that does not cover
 *     that surface kind, so the obligation can NEVER be closed. The
 *     denominator grows, the numerator cannot, and the percentage falls for
 *     ever with no action anywhere that would raise it. OUR CONFIGURATION
 *     ERROR, and the only group on this panel somebody should act on.
 *   · NOT_A_DECLARED_TYPE — the policy names something that is not a test type
 *     at all. The same class of thing: a typo, fixed by editing the policy.
 *   · UNRUNNABLE_HERE — the type is RIGHT for the axis and this deployment
 *     cannot execute it. A fact about the image, not about the policy or the
 *     application, and the remedy is to install the tool.
 *   · NO_PRODUCER — the type is right, runnable, and no producer in QAAI can
 *     propose one. OUR backlog, and the only one of the four that STAYS in the
 *     denominator, because shedding it would raise the customer's coverage
 *     number for a shortfall in this product.
 *
 * Rendered as one list, "edit your policy" sits beside "install k6" sits beside
 * "wait for us", and the one group that is actionable looks exactly like the
 * three that are not. That is the same defect ./plan-skipped.ts exists for, on a
 * different list, and the fix is the same: SAY WHICH.
 *
 * ── THE TWO FACTS THAT MUST NOT MERGE ───────────────────────────────────────
 *
 * `countsInDenominator` is on every section because "this obligation left the
 * denominator with a reason" and "this obligation is genuinely uncovered debt"
 * are different readings of the same number, and a panel that printed four
 * identical lists would let a reader believe the percentage already accounts
 * for all of them. Three of these groups raise the percentage by leaving; the
 * fourth does not, and the register's rule is that a cap applied without being
 * disclosed is the one thing a coverage product may never do.
 *
 * NO NEW VISUAL LANGUAGE. This file returns GROUPS and nothing else: no colour,
 * no class, no icon. The page renders each group with the SectionLabel and list
 * markup it already uses — the only change is that there are up to four
 * labelled lists instead of one unlabelled one, in the order a reader should
 * read them.
 */

/** The audit's four refusals, mirroring `OBLIGATION_REFUSALS` in packages/agent. */
export type ObligationRefusal =
  'IMPOSSIBLE_FOR_AXIS' | 'NOT_A_DECLARED_TYPE' | 'UNRUNNABLE_HERE' | 'NO_PRODUCER';

/** One adjudicated (axis, type) obligation. `type` is a string: a stored policy can name anything. */
export interface ObligationVerdict {
  readonly kind: string;
  readonly type: string;
  readonly counts: boolean;
  readonly refusal: ObligationRefusal | null;
  readonly why: string;
}

/** What one axis owes, and what could ever discharge it. */
export interface ObligationAxis {
  readonly kind: string;
  readonly declared: readonly string[];
  readonly satisfiable: readonly string[];
  readonly coversButNotStorable: readonly string[];
  readonly closeable: boolean;
}

/** `GET /coverage/:projectId/obligations`, on the wire. */
export interface ObligationAuditView {
  readonly projectId: string;
  readonly policy: {
    /** False means this project never stated its obligations — NOT "owes nothing". */
    readonly declared: boolean;
    /** A policy IS stored and does not parse. Read as none, and disclosed. */
    readonly unreadable: boolean;
    readonly byKind: Readonly<Record<string, readonly string[]>> | null;
    readonly why: string;
  };
  readonly counted: number;
  readonly verdicts: readonly ObligationVerdict[];
  readonly excluded: readonly ObligationVerdict[];
  readonly impossible: readonly ObligationVerdict[];
  readonly refusals: readonly string[];
  readonly outOfDenominator: readonly string[];
  readonly axes: readonly ObligationAxis[];
  readonly capability: {
    readonly probed: boolean;
    readonly measuredAtIso: string | null;
    readonly why: string;
  };
  readonly why: string;
}

/**
 * The four groups, in READING ORDER — which is the whole editorial decision in
 * this file: what somebody on this screen can fix first, what an operator can
 * fix second, and our own backlog last.
 */
export const OBLIGATION_GROUPS = [
  {
    refusal: 'IMPOSSIBLE_FOR_AXIS',
    label: 'Obligations no test type can ever close — correct the policy',
    note: 'Each of these names a test type that does not cover that surface kind. The obligation can never be satisfied, so it is OUT of the denominator rather than reported as permanent debt — but while it is in the policy it is a configuration error here, not a finding about the application.',
    countsInDenominator: false,
  },
  {
    refusal: 'NOT_A_DECLARED_TYPE',
    label: 'Obligations naming something that is not a test type',
    note: 'The policy names a type this product does not declare — a typo, or a type that has since been removed. Nothing can satisfy it, so it is OUT of the denominator. Re-save the policy.',
    countsInDenominator: false,
  },
  {
    refusal: 'UNRUNNABLE_HERE',
    label: 'The right type, and this deployment cannot run it',
    note: 'Not a defect in the policy and not a finding about the application: the type covers the axis and the tool, browser or driver is missing from this image. The obligation is OUT of the denominator with that reason, so the percentage is over what this deployment can actually run — install the tool and it returns.',
    countsInDenominator: false,
  },
  {
    refusal: 'NO_PRODUCER',
    label: 'The right type, runnable, and QAAI cannot propose one yet',
    note: 'These obligations STAY in the denominator and are honestly uncovered. The missing piece is ours, not yours: shedding them would raise your coverage number because of a shortfall in this product. Our backlog.',
    countsInDenominator: true,
  },
] as const;

export type ObligationGroup = (typeof OBLIGATION_GROUPS)[number]['refusal'];

export interface ObligationSection {
  readonly refusal: ObligationGroup;
  readonly label: string;
  readonly note: string;
  /** Whether these obligations are still counted as debt. The fact that must not merge. */
  readonly countsInDenominator: boolean;
  readonly entries: readonly ObligationVerdict[];
}

/**
 * Split the audit's refusals into their reading order.
 *
 * Reads `verdicts` and NOT `excluded`, deliberately: `NO_PRODUCER` is a refusal
 * that STAYS in the denominator, so it is absent from `excluded` by design, and
 * a reader of that field alone would silently drop the one group whose owner is
 * us. Three of these four lists are the excluded set; the fourth is not, and
 * that asymmetry is the audit's central honesty rule rather than an oversight.
 *
 * A group with no entries is OMITTED rather than rendered empty, because an
 * empty "no test type can close these" heading reads as a claim that the policy
 * was checked and found clean — which is true, and is not what a bare heading
 * with nothing under it communicates.
 *
 * Pure, total and order-preserving within each group: the audit iterates
 * `SURFACE_KINDS`, a constant, so the server's order is stable and so is this.
 */
export function groupObligations(audit: ObligationAuditView | null): ObligationSection[] {
  if (audit === null) return [];

  const byRefusal = new Map<string, ObligationVerdict[]>();
  for (const verdict of audit.verdicts) {
    if (verdict.refusal === null) continue;
    const bucket = byRefusal.get(verdict.refusal);
    if (bucket) bucket.push(verdict);
    else byRefusal.set(verdict.refusal, [verdict]);
  }

  const sections: ObligationSection[] = [];
  for (const group of OBLIGATION_GROUPS) {
    const entries = byRefusal.get(group.refusal);
    if (entries === undefined || entries.length === 0) continue;
    sections.push({
      refusal: group.refusal,
      label: group.label,
      note: group.note,
      countsInDenominator: group.countsInDenominator,
      entries,
    });
  }
  return sections;
}

/**
 * Refusals the SERVER adjudicated that this file has no group for.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * `OBLIGATION_REFUSALS` lives in packages/agent and apps/web cannot import it,
 * so the four groups above are literals and the two halves can drift. The
 * drift is ONE-WAY and silent in the dangerous direction: a fifth refusal added
 * in packages/agent arrives on the wire inside `verdicts` — the API derives the
 * published vocabulary from the agent's own list, so it needs no edit — and
 * `groupObligations` would quietly omit every obligation carrying it. A reader
 * would see a shorter list and no indication that anything was left out, which
 * is the "a cap applied without being disclosed" failure with the cap being our
 * own stale vocabulary.
 *
 * So the unknown names are REPORTED rather than truncated. The lookup is by
 * STRING on purpose: a deployed web build is routinely older than the API it
 * talks to, and a reader that could only represent the four names it was
 * compiled with would be unable to notice the fifth.
 */
export function ungroupedRefusals(audit: ObligationAuditView | null): string[] {
  if (audit === null) return [];
  const known = new Set<string>(OBLIGATION_GROUPS.map((group) => group.refusal));
  const unknown = new Set<string>();
  for (const verdict of audit.verdicts) {
    if (verdict.refusal === null) continue;
    if (!known.has(verdict.refusal)) unknown.add(verdict.refusal);
  }
  return [...unknown];
}

/**
 * The panel's heading.
 *
 * A FUNCTION AND NOT A TEMPLATE IN THE COMPONENT, because the zero case is
 * wrong in a way a count cannot express: the panel also renders when a stored
 * policy does not PARSE, and when the server adjudicated a refusal this build
 * has no group for. In both of those there are no listed obligations, and
 * "0 declared obligations no test can close today" is then a headline that
 * contradicts the paragraph under it — it reads as an all-clear over the one
 * screen that exists to say something is wrong.
 *
 * So the heading names whichever fact brought the panel up, and the count is
 * used only when there is something counted. Pure, so it is pinned by a test
 * rather than by somebody opening the page with a broken policy.
 */
export function obligationHeading(audit: ObligationAuditView): string {
  const counted = groupObligations(audit).reduce((sum, section) => sum + section.entries.length, 0);
  if (counted > 0) return `${counted} declared obligation(s) no test can close today`;
  if (audit.policy.unreadable) return 'This obligation policy could not be read';
  if (ungroupedRefusals(audit).length > 0) {
    return 'Obligations this page cannot explain yet';
  }
  /*
   * Unreachable through the panel, which renders only when
   * `obligationsNeedSaying` is true. Returned rather than thrown because a
   * heading is not worth a crash, and stated rather than left blank so a caller
   * that forgot the predicate sees why its panel is empty.
   */
  return 'Nothing to report about this obligation policy';
}

/**
 * Whether this panel has anything to say at all.
 *
 * FALSE FOR THE COMMON CASE, which is the point. Most projects have never
 * stated their obligations — the column is nullable with no default and the
 * default owes nothing — and a panel that appeared on every coverage screen to
 * report that nothing is owed would be a nag that teaches people to skip the
 * one time it says something. So it renders when a stored policy cannot be
 * read, or when a refusal needs an owner named, and otherwise not at all.
 *
 * A clean declared policy is deliberately silent here: its obligations are
 * already in the TEST_TYPE axis of the coverage report, and repeating the count
 * on a second surface is how two numbers for one fact start.
 */
export function obligationsNeedSaying(audit: ObligationAuditView | null): boolean {
  if (audit === null) return false;
  if (audit.policy.unreadable) return true;
  /*
   * A verdict this build cannot name is a reason to render, not a reason to
   * stay quiet: the alternative is a panel that is silent precisely because it
   * did not understand what it was told.
   */
  if (ungroupedRefusals(audit).length > 0) return true;
  return groupObligations(audit).length > 0;
}
