import type { ClusterReport } from '../../lib/api';

/**
 * The shapes and the arithmetic behind the cause-grouped verdict queue.
 *
 * Kept out of the page because it is the one part of that screen that can be
 * wrong in a way nobody would see: a grouping bug does not throw, it just
 * quietly puts two unrelated failures under one sentence and offers to decide
 * both at once.
 */

export interface TriageVerdict {
  id: string;
  verdict: 'REAL_BUG' | 'INTENDED_CHANGE' | 'FLAKE' | 'ENV_ISSUE';
  confidence: number;
  explanation: string;
  evidence: Array<{ kind: string; ref: string; detail: string }>;
  reviewState: 'PENDING' | 'ACCEPTED' | 'OVERRIDDEN' | 'MUTED';
  model: string;
  createdAt: string;
  testResult: {
    id: string;
    runId: string;
    status: string;
    test: { id: string; name: string; filePath: string; priority: string };
  };
}

export type VerdictKind = TriageVerdict['verdict'];

export type Tone = 'neutral' | 'accent' | 'pass' | 'fail' | 'flake';

export const VERDICT_META: Record<VerdictKind, { label: string; blurb: string; tone: Tone }> = {
  REAL_BUG: {
    label: 'Real bug',
    blurb: 'The application is wrong. This is the only verdict that blocks a merge by default.',
    tone: 'fail',
  },
  INTENDED_CHANGE: {
    label: 'Intended change',
    blurb:
      'The app changed on purpose and the test is now out of date — the healer proposes a fix.',
    tone: 'flake',
  },
  FLAKE: {
    label: 'Flake',
    blurb: 'Nothing is broken; the test is unreliable. Consider quarantining it.',
    tone: 'flake',
  },
  ENV_ISSUE: {
    label: 'Environment issue',
    blurb: 'The environment failed, not the app. Alerts, never gates.',
    tone: 'neutral',
  },
};

export const OVERRIDES: readonly VerdictKind[] = [
  'REAL_BUG',
  'INTENDED_CHANGE',
  'FLAKE',
  'ENV_ISSUE',
];

export const metaFor = (verdict: string) =>
  VERDICT_META[verdict as VerdictKind] ?? VERDICT_META.ENV_ISSUE;

/** `REAL BUG`, `INTENDED CHANGE` — the chip face, derived so there is one source. */
export const chipLabel = (verdict: string) => metaFor(verdict).label.toUpperCase();

/** One cause and every failure that shares it. A cause of one is still a cause. */
export interface CauseGroup {
  key: string;
  /** What a person would call this, from the clusterer — or the test's own name. */
  label: string;
  members: TriageVerdict[];
  /** The verdict the agent gave most of these failures. */
  verdict: VerdictKind;
  /** Mean confidence across the members carrying that verdict. */
  confidence: number;
  /** False when the agent did not say the same thing about every member. */
  unanimous: boolean;
  /** The agent's own sentence, taken from the member it was surest about. */
  explanation: string;
}

/** testResultId → the cause it belongs to, for causes with more than one member. */
export type CauseIndex = Map<string, { signature: string; label: string }>;

/**
 * Read the cluster reports into a flat index.
 *
 * Keyed on `signature` rather than the cluster id so the same cause showing up
 * in two runs is one group here. The id is per-report; the signature is what
 * the clusterer computed from the failure itself.
 */
export function indexCauses(reports: Array<ClusterReport | null>): CauseIndex {
  const index: CauseIndex = new Map();
  for (const report of reports) {
    if (!report) continue;
    for (const cluster of report.clusters) {
      // A cluster of one is not a cause worth grouping under — the endpoint
      // says as much by keeping those in `unclustered`, and a "group" with one
      // row in it would offer to decide 1 failure in bulk.
      if (cluster.count < 2) continue;
      for (const member of cluster.members) {
        index.set(member.testResultId, { signature: cluster.signature, label: cluster.label });
      }
    }
  }
  return index;
}

function summarise(key: string, label: string, members: TriageVerdict[]): CauseGroup {
  const tally = new Map<VerdictKind, TriageVerdict[]>();
  for (const member of members) {
    const bucket = tally.get(member.verdict) ?? [];
    bucket.push(member);
    tally.set(member.verdict, bucket);
  }

  let dominant = members[0]!.verdict;
  let held = tally.get(dominant)!;
  for (const [verdict, holders] of tally) {
    const better =
      holders.length > held.length ||
      // A tie goes to whichever the agent was surest about, not to map order.
      (holders.length === held.length && maxConfidence(holders) > maxConfidence(held));
    if (better) {
      dominant = verdict;
      held = holders;
    }
  }

  const surest = held.reduce((best, v) => (v.confidence > best.confidence ? v : best), held[0]!);

  return {
    key,
    label,
    members,
    verdict: dominant,
    confidence: held.reduce((sum, v) => sum + v.confidence, 0) / held.length,
    unanimous: tally.size === 1,
    explanation: surest.explanation,
  };
}

const maxConfidence = (verdicts: TriageVerdict[]) =>
  verdicts.reduce((high, v) => Math.max(high, v.confidence), 0);

/**
 * Verdicts, grouped by what actually broke.
 *
 * Anything the clusterer could not put with something else comes back in
 * `singles` — including a failure whose cluster-mates have already been
 * reviewed and are therefore not on screen. A group of one is drawn as one
 * failure, never as a cluster with a count of 1.
 */
export function groupByCause(
  verdicts: TriageVerdict[],
  causes: CauseIndex,
): { groups: CauseGroup[]; singles: CauseGroup[] } {
  const buckets = new Map<string, { label: string; members: TriageVerdict[] }>();

  for (const verdict of verdicts) {
    const cause = causes.get(verdict.testResult.id);
    const key = cause ? `cause:${cause.signature}` : `one:${verdict.id}`;
    const bucket = buckets.get(key) ?? {
      label: cause?.label ?? verdict.testResult.test.name,
      members: [],
    };
    bucket.members.push(verdict);
    buckets.set(key, bucket);
  }

  const all = [...buckets].map(([key, bucket]) => summarise(key, bucket.label, bucket.members));
  const newest = (group: CauseGroup) =>
    Math.max(...group.members.map((m) => new Date(m.createdAt).getTime()));

  return {
    groups: all
      .filter((group) => group.members.length > 1)
      .sort((a, b) => b.members.length - a.members.length || newest(b) - newest(a)),
    singles: all.filter((group) => group.members.length === 1).sort((a, b) => newest(b) - newest(a)),
  };
}
