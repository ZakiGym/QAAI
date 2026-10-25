/**
 * What the API can say about a crawl BEFORE it runs, and what the last one left
 * behind.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * `POST /projects/:id/explore` used to answer with a job id and nothing else,
 * while quietly clamping the crawl to 25 pages and depth 3. So the three
 * numbers that decide what a coverage percentage is a percentage OF were
 * invisible at the only moment a person is looking: the moment they ask for the
 * crawl. A customer arguing about a number had nothing to argue with, and a
 * cap nobody chose read exactly like a measurement of their whole application.
 *
 * Everything here is a READ. The crawl itself runs in the worker, which owns
 * the write side (`apps/worker/src/processors/explore.ts`); this is the half
 * the request path needs:
 *
 *   • the budget that WILL apply, resolved from the environment's own
 *     `crawlPolicy` and clamped by the org's plan, with every clamp named;
 *   • whether the last crawl left a frontier worth CONTINUING, which is the
 *     difference between an application over the cap that can eventually be
 *     fully enumerated and one that never can;
 *   • the device dimensions the variant pass is planned against — the read path
 *     for the `SurfaceDimension` rows the worker writes, so the table is not a
 *     write-only pile nothing can surface.
 */

import {
  observationFrom,
  reconcileCalledEndpoints,
  resolveCrawlBudget,
  resumeAdvice,
  resumePointFrom,
  type ResolvedCrawlBudget,
} from '@qaai/agent';
import type { Plan, SurfaceDimensionKind } from '@qaai/shared';
import { prisma } from './prisma.js';

/**
 * The budget as it will be applied, in the shape a response renders.
 *
 * `chosenFields` is the one a reader needs most: it separates a deliberate
 * 50-page budget from this build's default, so "why did it only find 50
 * pages" has an answer that is not a guess. `clampedByPlan` is the other half
 * — a FREE org's 100-page ceiling is below the default, so the clamp is the
 * reason and the plan is the remedy.
 */
export interface CrawlBudgetSummary {
  pageBudget: number;
  maxDepth: number;
  perTemplatePageBudget: number;
  wallClockMillis: number;
  plan: Plan;
  /** Fields the environment's stored policy actually set. */
  chosenFields: string[];
  /** Limits the plan ceiling lowered, with both numbers in `notes`. */
  clampedByPlan: string[];
  /**
   * True when the environment has NO stored policy at all. Distinct from one
   * that stored an empty object: one never decided, the other decided to accept
   * every default, and only the second is a decision.
   */
  defaulted: boolean;
  /** Keys in the stored policy this build does not know. Reported, not dropped. */
  unknownKeys: string[];
  /** One sentence per clamp and per rejected override. */
  notes: string[];
}

/** Whether the next crawl continues the last one, and the sentence that says so. */
export interface CrawlResumeSummary {
  resumable: boolean;
  /** In-scope URLs the last accepted crawl held and never visited. */
  pending: number;
  /** The version the frontier came from, when there is one. */
  fromVersion: number | null;
  why: string;
}

export interface CrawlDimensionSummary {
  kind: SurfaceDimensionKind;
  key: string;
  label: string;
  isDefault: boolean;
  available: boolean;
  evidence: string;
}

export function summariseBudget(budget: ResolvedCrawlBudget): CrawlBudgetSummary {
  return {
    pageBudget: budget.limits.pageBudget,
    maxDepth: budget.limits.maxDepth,
    perTemplatePageBudget: budget.limits.perTemplatePageBudget,
    wallClockMillis: budget.limits.wallClockMillis,
    plan: budget.plan,
    chosenFields: budget.policy.overridden.map(String),
    clampedByPlan: budget.clamped.map((clamp) => String(clamp.field)),
    defaulted: budget.policy.defaulted,
    unknownKeys: budget.policy.unknownKeys,
    notes: [
      ...budget.clamped.map((clamp) => clamp.why),
      ...budget.rejected.map((entry) => `the ${entry.field} override was ignored: ${entry.why}`),
      ...budget.policy.unknownKeys.map(
        (key) => `the stored crawl policy has a key this build does not know: ${key}`,
      ),
    ],
  };
}

/**
 * The budget the next crawl of this environment will run under.
 *
 * `overrides` is what the request body asked for, and it is folded into the
 * STORED POLICY rather than applied behind it, so it travels through
 * `resolveCrawlPolicy`'s per-field type checking and comes back named in
 * `chosenFields`. A caller that asks for 25 pages gets 25 pages AND a response
 * that says the 25 was theirs.
 */
export async function budgetForEnvironment(input: {
  environmentId: string;
  plan: Plan;
  overrides?: { maxPages?: number; maxDepth?: number };
}): Promise<CrawlBudgetSummary> {
  const environment = await prisma.environment.findUnique({
    where: { id: input.environmentId },
    select: { crawlPolicy: true },
  });

  const stored = environment?.crawlPolicy ?? null;
  const asked: Record<string, number> = {};
  if (typeof input.overrides?.maxPages === 'number' && input.overrides.maxPages > 0) {
    asked.pageBudget = input.overrides.maxPages;
  }
  if (typeof input.overrides?.maxDepth === 'number' && input.overrides.maxDepth > 0) {
    asked.maxDepth = input.overrides.maxDepth;
  }
  const storedPolicy =
    Object.keys(asked).length === 0
      ? stored
      : {
          ...(stored !== null && typeof stored === 'object' && !Array.isArray(stored)
            ? stored
            : {}),
          ...asked,
        };

  return summariseBudget(resolveCrawlBudget({ storedPolicy, plan: input.plan }));
}

/**
 * Whether the last ACCEPTED crawl of this environment left a frontier.
 *
 * The acceptance filter is load-bearing: a resume point whose visited set is
 * full of bot-wall pages would make the next crawl SKIP the real ones, so a
 * degraded crawl's frontier is never offered. `acceptance: null` is included
 * because it is every row written before adjudication existed, and that is not
 * evidence of degradation.
 */
export async function resumePointForEnvironment(input: {
  projectId: string;
  environmentId: string;
}): Promise<CrawlResumeSummary> {
  const row = await prisma.flowMap.findFirst({
    where: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      OR: [{ acceptance: 'ACCEPTED' }, { acceptance: null }],
    },
    orderBy: { version: 'desc' },
    select: { version: true, graph: true },
  });

  const snapshot = resumePointFrom(row?.graph ?? null);
  const advice = resumeAdvice(snapshot);
  return {
    resumable: advice.resumable,
    pending: advice.pending,
    fromVersion: snapshot === null ? null : (row?.version ?? null),
    why: advice.why,
  };
}

/**
 * The dimension values this project's cells are counted over.
 *
 * THE READ PATH for `SurfaceDimension`. The worker writes the device set the
 * variant pass was planned against; without a read the table is a write-only
 * pile and `check:wiring` is right to call it disconnected. Retired rows are
 * excluded — a value the reader stopped finding keeps its row as an audit trail
 * and must not go on being counted.
 */
export async function dimensionsForProject(
  projectId: string,
  kind?: SurfaceDimensionKind,
): Promise<CrawlDimensionSummary[]> {
  const rows = await prisma.surfaceDimension.findMany({
    where: { projectId, retiredAt: null, ...(kind ? { kind } : {}) },
    orderBy: [{ kind: 'asc' }, { key: 'asc' }],
    select: {
      kind: true,
      key: true,
      label: true,
      isDefault: true,
      available: true,
      evidence: true,
    },
  });
  return rows.map((row) => ({
    kind: row.kind,
    key: row.key,
    label: row.label,
    isDefault: row.isDefault,
    available: row.available,
    evidence: row.evidence,
  }));
}

/**
 * What the last crawl of this environment OBSERVED, as the report renders it.
 *
 * The read path for the observation report. Without one the whole network
 * inventory is computed during the crawl and discarded, which is a feature
 * indistinguishable from one that was never built.
 *
 * `null` means this crawl recorded no observation — which is every flow map
 * written before this slice — and it must never be rendered as "the application
 * made no calls". That is why the return type is nullable rather than an empty
 * summary: a zero here would be the exact lie the capability reporting inside
 * the observer exists to prevent.
 */
export interface CrawlObservationSummary {
  /** Endpoints the UI called, as canonical `METHOD /template` identities. */
  endpointsCalled: number;
  /**
   * Endpoints the UI called that no detector declared. A FINDING: either a
   * client we cannot read, or a route table we failed to parse — and the second
   * is evidence about our own extractor, which it would be dishonest to hide.
   */
  calledButNeverDeclared: Array<{ key: string; label: string; evidence: string }>;
  /** Distinct runtime defects, deduplicated by signature across the crawl. */
  runtimeErrors: number;
  /** Requested routes that bounced somewhere else, with the kind that decided. */
  bounces: number;
  /** Export and document surfaces, URL-backed or client-assembled. */
  documents: number;
  /** Error-path probes that were issued, with their verdicts. */
  probes: number;
  /**
   * Events that arrived before any node was focused. Counted rather than
   * dropped: an adapter that attaches late loses the first page's network, and
   * a silent zero would read as a quiet page.
   */
  unattributedEvents: number;
  /** Capabilities the adapter did not declare. UNAVAILABLE, never "nothing there". */
  unavailable: string[];
}

export async function observationForEnvironment(input: {
  projectId: string;
  environmentId: string;
  /** Declared endpoint surface keys, so the reconciliation runs in one vocabulary. */
  declaredKeys?: Iterable<string>;
}): Promise<{ version: number; observation: CrawlObservationSummary } | null> {
  const row = await prisma.flowMap.findFirst({
    where: { projectId: input.projectId, environmentId: input.environmentId },
    orderBy: { version: 'desc' },
    select: { version: true, graph: true },
  });

  const observation = observationFrom(row?.graph ?? null);
  if (observation === null || row === null) return null;

  const reconciled = reconcileCalledEndpoints(observation.calls, input.declaredKeys ?? []);
  return {
    version: row.version,
    observation: {
      endpointsCalled: observation.calls.length,
      calledButNeverDeclared: reconciled.calledButNeverDeclared.map((finding) => ({
        key: finding.key,
        label: finding.label,
        evidence: finding.evidence,
      })),
      runtimeErrors: observation.errors.length,
      bounces: observation.bounces.length,
      documents: observation.documents.length,
      probes: observation.probes.length,
      unattributedEvents: observation.unattributedEvents,
      unavailable: observation.capabilities
        .filter((entry) => entry.state === 'UNAVAILABLE')
        .map((entry) => entry.capability),
    },
  };
}
