/**
 * Explore processor (§3.1): crawl the app, ask the Explorer what is worth
 * testing, persist the Flow Map and the proposed plan.
 *
 * The crawl and the plan are stored separately and versioned separately. That
 * matters for the "3 uncovered flows — propose tests" prompt in the cockpit:
 * a later crawl can be diffed against the tests that already exist without
 * re-running the model.
 */

import {
  analyzeCoverage,
  canScaffoldWithoutModel,
  crawlApp,
  holdForInterstitial,
  planItemForGap,
  proposePlan,
  resumeAdvice,
  resumePointFrom,
  withObservation,
  withResumePoint,
} from '@qaai/agent';
import type { AuthProfileChoice, CrawlOutcome } from '@qaai/agent';
import { adjudicateCrawl } from '@qaai/shared';
import type {
  CrawlAcceptance,
  ExploreJob,
  FlowMap,
  FlowNode,
  Plan,
  TestPlan,
  TestType,
} from '@qaai/shared';
import { effectivePlan } from '../../../api/src/lib/start-run.js';
import { config, llm, logger, prisma, publishEvent } from '../context.js';
import { secretsFor } from '../vault.js';
import { enqueueGenerate } from '../queues.js';

/** Parity with the Explorer's own default, so both paths propose the same size. */
const MAX_PLAN_ITEMS = 12;

/**
 * The plan a crawl can produce with no model at all.
 *
 * `analyzeCoverage` compares the crawl against the suite; on a project with no
 * tests every route, form, affordance and journey it saw comes back as a gap,
 * and `planItemForGap` turns each into a complete PlanItem — title, rationale,
 * priority, ordered steps, assertions. Both are pure, both are unit tested in
 * packages/agent/src/coverage.test.ts, and routes/coverage.ts and
 * routes/traffic.ts have shipped on them for a while.
 *
 * They were never reachable from the first-run path, which is the only path a
 * new customer takes. Without a key `proposePlan` threw, the whole job failed,
 * the finished FlowMap was left with no plan pointing at it, and onboarding sat
 * on a spinner for five minutes before claiming "the crawl did not finish" —
 * about a crawl that had in fact finished and was sitting in the database.
 */
function planFromCrawl(
  flowMap: FlowMap,
  reason: string,
  authProfiles: AuthProfileChoice[],
  caveats: readonly string[] = [],
): TestPlan {
  /*
   * The roles are passed even here — ESPECIALLY here. This is the no-key path,
   * the one every new customer takes on their first run, so it is where a gap
   * behind an auth wall is most likely to be turned into a test. Without the
   * profiles every such item would come out unbound and assert nothing but the
   * redirect, which is the loop this change exists to break.
   */
  const report = analyzeCoverage({ flowMapGraph: flowMap, tests: [], authProfiles });
  const chosen = report.gaps.slice(0, MAX_PLAN_ITEMS);

  return {
    summary:
      `${chosen.length} test${chosen.length === 1 ? '' : 's'} proposed directly from the crawl of ` +
      `${flowMap.baseUrl} — ${report.totals.routes} route(s), ${report.totals.forms} form(s) and ` +
      `${report.totals.journeys} journey(s) seen. Written by the crawler, not by a model: ${reason} ` +
      `Every item below is real and approvable; turning an approved item into code is the step that ` +
      `needs the model.`,
    // The reason rides in `skipped` too, because that is the field the approval
    // screen renders as "deliberately not proposed" — a plan that is quietly
    // shorter than usual has to say why, or it reads as the agent's judgement.
    skipped: [
      { what: 'Model-written test proposals', why: reason },
      /*
       * The enumeration caveats ride in `skipped` because that is the field the
       * approval screen renders as "deliberately not proposed". A plan built
       * over a denominator that was truncated, refused or held as a candidate
       * has to say so where the person approving it is looking — a percentage
       * quoted against an unknown whole with no sentence beside it is the one
       * output this product may not produce.
       */
      ...caveats.map((why) => ({ what: 'Enumeration caveat', why })),
      ...report.gaps.slice(MAX_PLAN_ITEMS, MAX_PLAN_ITEMS + 50).map((gap) => ({
        what: gap.title,
        why: `ranked below the top ${MAX_PLAN_ITEMS} gaps from this crawl`,
      })),
    ],
    items: chosen.map(planItemForGap),
    flowMapVersion: flowMap.version,
  };
}

// ─── The acceptance gate ────────────────────────────────────────────────────

/**
 * Whether this crawl is allowed to BE the denominator.
 *
 * TWO STEPS, in this order, and the second is not optional.
 *
 * `adjudicateCrawl` reads the counts a crawl produces when something is wrong:
 * zero nodes, rate limiting, TLS failures, an auth wall reached WITH
 * credentials, a collapse against the last accepted map.
 *
 * `holdForInterstitial` reads the one case the counts cannot see. A bot
 * challenge, a consent wall and a maintenance page all answer 200, with one
 * node, no error statuses and no throttling — so adjudication ALONE returns
 * ACCEPTED, the wall becomes the denominator, the numerator does not move, and
 * the coverage percentage goes UP on the day the customer's environment started
 * refusing us. The interstitial classifier is the only thing in the product
 * that stops that, and it can only ever make the verdict worse.
 *
 * Pure and exported so the composition is testable: the ordering is the
 * behaviour, and an inline version of it would be untestable in exactly the way
 * the old crawl was.
 */
export function adjudicateExplore(input: {
  outcome: CrawlOutcome;
  /** True when an auth profile's storageState was supplied to the crawl. */
  authenticated: boolean;
  previous: { version: number; nodeCount: number } | null;
}): CrawlAcceptance {
  const { outcome } = input;
  const adjudicated: CrawlAcceptance = adjudicateCrawl({
    nodeCount: outcome.flowMap.nodes.length,
    errorNodeCount: outcome.degradationCounts.errorNodeCount,
    loadFailureCount: outcome.degradationCounts.loadFailureCount,
    throttledCount: outcome.degradationCounts.throttledCount,
    // Exactly "a profile was supplied AND we were bounced to a login anyway".
    // Either half alone is not a degradation: an anonymous crawl SHOULD hit the
    // wall, and a profile that was never needed is not evidence of anything.
    expectedAuthButHitWall: input.authenticated && outcome.degradationCounts.authWallBounces > 0,
    tlsFailureCount: outcome.degradationCounts.tlsFailureCount,
    previous: input.previous,
  });
  return outcome.interstitial
    ? holdForInterstitial(adjudicated, outcome.interstitial)
    : adjudicated;
}

// ─── Incremental merge: a disappeared node is TWO different facts ────────────

/**
 * What a merge did, because "the denominator changed" needs a reason attached.
 *
 * `carried` is the number that matters. A node in the previous map and not in
 * this one is either GONE (the feature was deleted) or NOT REACHED (this crawl
 * ran out of budget before it got there), and those are completely different
 * facts about the application. Today every crawl writes a new version that
 * REPLACES the last, so the second case silently deletes real surface and the
 * coverage percentage goes UP — which is the lie this slice exists to remove.
 */
export interface MergeReport {
  added: number;
  /** Seen in both. The previous node's content is replaced by the fresh read. */
  refreshed: number;
  /**
   * In the previous map, not in this one, and KEPT: this crawl could not prove
   * it is gone. Carried with its previous content and counted here.
   */
  carried: number;
  /**
   * In the previous map, not in this one, and DROPPED: this enumeration
   * CONVERGED over the whole in-scope surface, so a route it did not reach is
   * a route that no longer exists.
   */
  dropped: number;
  rule: string;
}

/**
 * Merges a fresh crawl into the previous accepted map.
 *
 * THE RULE, and it is the only honest one available: a node the fresh crawl did
 * not reach is dropped ONLY when the fresh crawl is entitled to say the surface
 * does not exist — which means enumeration CONVERGED and nothing was left in
 * the frontier. Anything less and the node is CARRIED, because "we did not get
 * there" and "it is gone" produce the same absence and guessing between them is
 * the lie.
 *
 * Carrying is the conservative direction: it keeps surface in the denominator
 * that might have been removed, so the percentage is too LOW rather than too
 * high. A dropped node that was merely unreached would make the percentage go
 * up with nobody told, and that is the failure mode this product cannot have.
 */
export function mergeFlowMaps(
  previous: FlowMap | null,
  fresh: FlowMap,
  input: { converged: boolean; atLeastMoreUrls: number },
): { merged: FlowMap; report: MergeReport } {
  if (previous === null || previous.nodes.length === 0) {
    return {
      merged: fresh,
      report: {
        added: fresh.nodes.length,
        refreshed: 0,
        carried: 0,
        dropped: 0,
        rule: 'no previous accepted map to merge into, so this crawl is the whole denominator',
      },
    };
  }

  const key = (node: FlowNode): string => `${node.route}#${node.stateKey}`;
  const freshByKey = new Map(fresh.nodes.map((node) => [key(node), node]));
  const mayDrop = input.converged && input.atLeastMoreUrls === 0;

  const nodes: FlowNode[] = [...fresh.nodes];
  const nodeIds = new Set(fresh.nodes.map((node) => node.id));
  let carried = 0;
  let dropped = 0;
  let refreshed = 0;
  const carriedIds = new Map<string, string>();

  for (const node of previous.nodes) {
    if (freshByKey.has(key(node))) {
      refreshed += 1;
      continue;
    }
    if (mayDrop) {
      dropped += 1;
      continue;
    }
    /*
     * Re-identified rather than kept under its old id: the fresh map numbers
     * its nodes `node-0..n` from the schedule's deterministic order, and
     * reusing a previous id would collide with a different state.
     */
    let id = node.id;
    while (nodeIds.has(id)) id = `carried-${nodes.length}-${id}`;
    nodeIds.add(id);
    carriedIds.set(node.id, id);
    nodes.push({ ...node, id });
    carried += 1;
  }

  const edges = [...fresh.edges];
  if (carried > 0) {
    // Only edges BETWEEN carried nodes come across. An edge from a carried node
    // into the fresh graph would point at an id that means something else now.
    for (const edge of previous.edges) {
      const from = carriedIds.get(edge.from);
      const to = carriedIds.get(edge.to);
      if (from === undefined || to === undefined) continue;
      edges.push({ ...edge, id: `edge-${edges.length}`, from, to });
    }
  }

  const rule = mayDrop
    ? `enumeration converged with an empty frontier, so ${dropped} node(s) the previous map had ` +
      `and this crawl did not reach are reported as REMOVED from the application`
    : `enumeration did not converge (${input.atLeastMoreUrls} in-scope URL(s) were known and not ` +
      `visited), so ${carried} node(s) from v${previous.version} are CARRIED rather than dropped: ` +
      `"we did not reach it" and "it is gone" are different facts and this crawl cannot tell them ` +
      `apart`;

  return {
    merged: { ...fresh, nodes, edges },
    report: { added: fresh.nodes.length - refreshed, refreshed, carried, dropped, rule },
  };
}

// ─── Enumeration completeness: converged, or merely unproven ────────────────

export interface CompletenessVerdict {
  /** CONVERGED only when the frontier emptied and no cap discarded anything. */
  state: 'CONVERGED' | 'UNPROVEN';
  /**
   * The share of nodes discovered in the LAST QUARTER of the visits. A small
   * number means the discovery rate had flattened, which is SUGGESTIVE and is
   * not proof — see `why`.
   */
  tailDiscoveryRate: number | null;
  why: string;
}

/**
 * Whether a percentage may be quoted against this denominator without a caveat.
 *
 * The saturation curve is the CHEAP HALF and it is all that is implemented
 * here: new nodes per page visited, and whether that rate had flattened by the
 * end. A flattened curve is evidence that the crawl was running out of new
 * surface; it is NOT evidence that none was left, because a disconnected
 * section reached only from a page the budget never opened produces exactly the
 * same flat tail. So a flat curve downgrades nothing and upgrades nothing — it
 * is reported beside the verdict and the verdict stays UNPROVEN.
 *
 * THE HARD HALF IS NOT IMPLEMENTED: proving that no unreached component exists
 * needs the route table from the repository compared against the crawl, which
 * is the source-analysis lane's reconciliation and a slice of its own.
 */
export function enumerationCompleteness(outcome: CrawlOutcome): CompletenessVerdict {
  const lower = outcome.flowMap.frontier?.atLeastMoreUrls ?? 0;
  const tail = tailDiscoveryRate(outcome.saturation);
  if (outcome.outcome === 'CONVERGED' && lower === 0) {
    return {
      state: 'CONVERGED',
      tailDiscoveryRate: tail,
      why:
        'every discovered URL in scope was visited and no cap discarded anything, so a ' +
        'percentage quoted against this denominator is a percentage of the whole known surface',
    };
  }
  const suffix =
    tail === null
      ? ''
      : `; ${Math.round(tail * 100)}% of the nodes were discovered in the last quarter of the ` +
        `visits, which is suggestive of saturation and is NOT proof of it — a section reachable ` +
        `only from a page the budget never opened produces the same flat tail`;
  return {
    state: 'UNPROVEN',
    tailDiscoveryRate: tail,
    why:
      `enumeration stopped rather than converged: at least ${lower} in-scope URL(s) were known ` +
      `and not visited, so any percentage quoted against this denominator is a percentage of an ` +
      `unknown whole${suffix}`,
  };
}

/** Null when there were too few visits for the share to mean anything. */
function tailDiscoveryRate(
  curve: ReadonlyArray<{ visited: number; nodes: number }>,
): number | null {
  if (curve.length < 8) return null;
  const cut = Math.floor(curve.length * 0.75);
  const atCut = curve[cut - 1]?.nodes ?? 0;
  const total = curve[curve.length - 1]?.nodes ?? 0;
  if (total === 0) return null;
  return (total - atCut) / total;
}

export async function processExplore(job: ExploreJob): Promise<void> {
  const { orgId, projectId, environmentId } = job;

  const environment = await prisma.environment.findFirst({
    where: { id: environmentId, orgId },
    // `crawlPolicy` is the whole point of the configurable budget: the crawl's
    // scope is reviewable on the environment it applies to, which an
    // environment variable or a hard-coded 25 is not.
    select: { id: true, baseUrl: true, projectId: true, crawlPolicy: true },
  });
  if (!environment) throw new Error(`Environment ${environmentId} not found for org ${orgId}`);

  /*
   * ── TWO LOOKUPS, NOT ONE, AND THE FILTER IS THE POINT ──────────────────────
   *
   * `newest` is for the VERSION NUMBER, which must not collide with a row that
   * already exists however degraded it was.
   *
   * `accepted` is for everything else — the merge baseline, the shrink
   * comparison and the resume point — and it filters `acceptance: 'ACCEPTED'`.
   * Without that filter a crawl run while the site was down becomes the
   * baseline for the NEXT crawl's shrink test, so the collapse is only ever
   * detected once and the degraded denominator becomes the new normal.
   * `acceptance: null` is included: it is every row written before adjudication
   * existed, and it is not evidence of degradation.
   */
  const [newest, accepted] = await Promise.all([
    prisma.flowMap.findFirst({
      where: { orgId, projectId, environmentId },
      orderBy: { version: 'desc' },
      select: { version: true },
    }),
    prisma.flowMap.findFirst({
      where: {
        orgId,
        projectId,
        environmentId,
        OR: [{ acceptance: 'ACCEPTED' }, { acceptance: null }],
      },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, nodeCount: true, graph: true },
    }),
  ]);
  const version = (newest?.version ?? 0) + 1;

  const previousMap = (accepted?.graph ?? null) as FlowMap | null;
  /*
   * THE REGISTER ITEM: "an incremental crawl that merges into the previous
   * map". The blocker was that the queue lived in a local `const` inside
   * `crawl()`, so an application over the cap could never be fully enumerated
   * however often it ran — every run started at the base URL and stopped at the
   * same budget. The snapshot is only taken from an ACCEPTED crawl: a resume
   * point whose visited set is full of bot-wall pages would make the next crawl
   * SKIP the real ones.
   */
  const resumeFrom = resumePointFrom(accepted?.graph ?? null);
  const resume = resumeAdvice(resumeFrom);

  const [subscription, org] = await Promise.all([
    prisma.subscription.findUnique({ where: { orgId }, select: { plan: true, status: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } }),
  ]);
  const orgPlan: Plan = effectivePlan(subscription, org?.plan ?? null).effective;

  /*
   * The environment's auth profiles, read once and used for two different
   * things.
   *
   * The FIRST is the crawl: a cached storageState lets the crawler get past the
   * login wall and see the half of the app that actually matters (§2), and the
   * oldest profile is the one used, as it always has been.
   *
   * The SECOND is new and is the point of this read being a findMany rather
   * than a findFirst: the plan. An item for a page behind the wall has to name
   * the role its test will assume, and it can only name a role it has been
   * shown. Id, name and kind only — choosing which role a test runs as needs
   * neither the config nor the live session, and both of those travel into plan
   * text that people read.
   */
  const profiles = await prisma.authProfile.findMany({
    where: { orgId, environmentId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, kind: true, storageState: true, storageStateExpiresAt: true },
  });
  const authProfileChoices: AuthProfileChoice[] = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
  }));
  const authProfile = profiles[0] ?? null;
  const storageState =
    authProfile?.storageState &&
    (!authProfile.storageStateExpiresAt || authProfile.storageStateExpiresAt > new Date())
      ? authProfile.storageState
      : undefined;

  logger.info({ projectId, baseUrl: environment.baseUrl, version }, 'crawl starting');
  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'log',
    data: { message: `Crawling ${environment.baseUrl}` },
    at: new Date().toISOString(),
  });

  /*
   * ── THE CONFIGURABLE BUDGET, END TO END ────────────────────────────────────
   *
   * `job.maxPages`/`maxDepth` are the API's hard-coded 25/3, clamped at 60/6 by
   * routes/agent.ts. They are now treated as an OPTIONAL CALLER OVERRIDE and a
   * value of 0 or less means "no override": the environment's own `crawlPolicy`
   * decides, clamped by the plan ceiling, and whatever bound the crawl is
   * reported in `policyApplied.overridden` and in the run event. A hard-coded
   * 25 is the reason "100% covered" meant "100% of at most 25 states", and it
   * could not be fixed inside the crawler while the caller overrode it.
   */
  const outcome: CrawlOutcome = await crawlApp({
    baseUrl: environment.baseUrl,
    projectId,
    environmentId,
    version,
    ...(job.maxPages > 0 ? { maxPages: job.maxPages } : {}),
    ...(job.maxDepth > 0 ? { maxDepth: job.maxDepth } : {}),
    crawlPolicy: environment.crawlPolicy,
    plan: orgPlan,
    storageState,
    role: authProfile?.name ?? null,
    resumeFrom,
    onProgress: (message) => {
      logger.debug({ message }, 'crawl progress');
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message },
        at: new Date().toISOString(),
      });
    },
  });

  /*
   * ── THE ACCEPTANCE GATE ────────────────────────────────────────────────────
   *
   * A crawl run while the site was down, rate-limited or logged out returns a
   * small graph. Stored as the newest version it replaces the denominator, the
   * numerator does not move, and the coverage percentage goes UP on the day the
   * customer's staging environment fell over — with nobody told.
   *
   * TWO STEPS, in this order, and the second is not optional. `adjudicateCrawl`
   * reads the counts: zero nodes, rate limiting, TLS failures, an auth wall
   * reached WITH credentials, a collapse against the last accepted map. A bot
   * challenge answers 200 with one page, no errors and no throttling, so
   * adjudication ALONE returns ACCEPTED and the wall becomes the denominator —
   * `holdForInterstitial` is the only thing that stops it, and it can only ever
   * make the verdict worse.
   */
  const acceptance = adjudicateExplore({
    outcome,
    authenticated: storageState !== undefined,
    previous: accepted ? { version: accepted.version, nodeCount: accepted.nodeCount } : null,
  });
  const promoted = acceptance.state === 'ACCEPTED';

  /*
   * ── THE INCREMENTAL MERGE ──────────────────────────────────────────────────
   *
   * Only an ACCEPTED crawl merges. A degraded one is stored on its own, visible
   * and diffable, and is NOT allowed to carry the previous map's nodes forward
   * under its own version — that would launder a bot wall into a denominator
   * that looks complete.
   */
  const completeness = enumerationCompleteness(outcome);
  const { merged, report: mergeReport } = promoted
    ? mergeFlowMaps(previousMap, outcome.flowMap, {
        converged: completeness.state === 'CONVERGED',
        atLeastMoreUrls: outcome.flowMap.frontier?.atLeastMoreUrls ?? 0,
      })
    : {
        merged: outcome.flowMap,
        report: {
          added: outcome.flowMap.nodes.length,
          refreshed: 0,
          carried: 0,
          dropped: 0,
          rule:
            `held as ${acceptance.state}, so nothing was merged: a degraded crawl must not ` +
            `become the denominator`,
        },
      };

  const flowMap: FlowMap = {
    ...merged,
    acceptance,
    provenance: { derivedFrom: 'CRAWL', acceptance: acceptance.state, outcome: outcome.outcome },
    truncatedReason:
      [merged.truncatedReason, completeness.state === 'UNPROVEN' ? completeness.why : null]
        .filter((line): line is string => line !== null && line !== '')
        .join('; ') || null,
  };

  const caveats = [
    ...outcome.caveats,
    mergeReport.rule,
    completeness.why,
    ...acceptance.reasons,
    resume.why,
  ];

  const stored = await prisma.flowMap.create({
    data: {
      orgId,
      projectId,
      environmentId,
      version,
      /*
       * The frontier snapshot rides in the graph, and ONLY for an accepted
       * crawl — see `mergeFlowMaps`. `FlowMap.frontierSnapshot Json?` is the
       * column it belongs in; the convention is read and written in exactly one
       * place (`withResumePoint`/`resumePointFrom` in @qaai/agent) so there is
       * one thing to change when the column lands.
       */
      /*
       * The observation report is stored for EVERY crawl, accepted or not: the
       * endpoints the UI called and the runtime errors it logged are facts
       * about the application whatever we decided about the denominator, and a
       * degraded crawl's bounce ledger is often the evidence for WHY it was
       * degraded. The frontier snapshot is the opposite and only an ACCEPTED
       * crawl writes one — a resume point whose visited set is full of
       * bot-wall pages would make the next crawl SKIP the real pages.
       */
      graph: withObservation(
        promoted ? withResumePoint(flowMap, outcome.snapshot) : { ...flowMap },
        outcome.observation,
      ) as unknown as object,
      nodeCount: flowMap.nodes.length,
      edgeCount: flowMap.edges.length,
      journeyCount: flowMap.journeys.length,
      truncatedReason: flowMap.truncatedReason,
      // Without this the column is null, `selectFlowMap` cannot tell a crawl
      // from a route table read out of the repository, and a source-derived
      // map at v9 goes on displacing a real crawl at v8.
      derivedFrom: 'CRAWL',
      acceptance: acceptance.state,
      // Never set for ACCEPTED and never null for the other two: "degraded"
      // with no reason is a denominator nobody can audit.
      acceptanceReason: promoted ? null : acceptance.reasons.join('; '),
      convergence: outcome.outcome,
      /*
       * THE MOST IMPORTANT COLUMN IN THE SLICE. Every cap is a lever that
       * silently flatters us; this is the number that makes the lever visible.
       * A floor and never an estimate.
       */
      atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
      excludedCount: flowMap.excluded?.length ?? null,
      policyApplied: flowMap.policyApplied as unknown as object,
    },
  });

  /*
   * ── THE DEVICE DIMENSION ROWS ──────────────────────────────────────────────
   *
   * The device set the variant pass was planned against, written from the SAME
   * objects the crawl was driven with. A row whose widthPx disagreed with the
   * viewport we actually set would make every cell on that axis a claim about a
   * configuration that never ran. `isDefault` is true for exactly one of them
   * (the 1280px viewport the URL pass itself uses), which matters because the
   * database does not enforce one default per (projectId, kind) and the
   * default-cell arithmetic is ambiguous with two.
   */
  for (const dimension of outcome.dimensions) {
    await prisma.surfaceDimension.upsert({
      where: {
        projectId_kind_key: {
          projectId,
          kind: dimension.kind,
          key: dimension.key,
        },
      },
      create: {
        orgId,
        projectId,
        kind: dimension.kind,
        key: dimension.key,
        label: dimension.label,
        source: dimension.source,
        evidence: dimension.evidence,
        isDefault: dimension.isDefault,
        available: dimension.available,
        detail: dimension.detail as unknown as object,
      },
      update: {
        label: dimension.label,
        evidence: dimension.evidence,
        isDefault: dimension.isDefault,
        available: dimension.available,
        detail: dimension.detail as unknown as object,
        // Cleared rather than left: a value the reader has found again is not
        // retired, and the row is the audit trail for both directions.
        retiredAt: null,
      },
    });
  }

  logger.info(
    {
      nodes: flowMap.nodes.length,
      edges: flowMap.edges.length,
      acceptance: acceptance.state,
      convergence: outcome.outcome,
      completeness: completeness.state,
      /*
       * Logged because it has no column. A re-crawl that detects a different
       * route mode re-keys every state and the version diff reads as a total
       * rewrite, so the value a crawl ran under has to be recoverable — a
       * `FlowMap.routeMode` field is requested, and until it lands this line is
       * the only record.
       */
      routeMode: outcome.routeMode,
      atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
      excluded: flowMap.excluded?.length ?? 0,
      pageBudget: outcome.budget.limits.pageBudget,
      plan: orgPlan,
      merge: mergeReport,
      variantsPlanned: outcome.variantPlan.variants.length,
      variantsRunnable: outcome.variantPlan.runnable,
      variantSurface: outcome.variantSurface.length,
      undeclaredEndpoints: outcome.observation.calls.length,
    },
    'crawl complete; asking the Explorer for a plan',
  );

  for (const caveat of caveats) {
    publishEvent(orgId, {
      runId: `explore:${projectId}`,
      type: 'log',
      data: { message: caveat },
      at: new Date().toISOString(),
    });
  }

  const secretNames = Object.keys(await secretsFor(orgId, environmentId));

  /*
   * The crawl is the expensive half — a browser, up to five minutes — and this
   * job runs with `attempts: 1`, so there is no retry to fall back on. Losing a
   * finished crawl because the step after it could not reach a model is the
   * wrong trade, and it is the trade that made the product unusable without a
   * key: the FlowMap landed, the plan never did, and every screen downstream
   * read as empty.
   *
   * So the model is best-effort and the crawl is not. Any failure here degrades
   * to the deterministic plan and says so on the plan itself — it fails OPEN and
   * the reason is carried to the human rather than swallowed. `writtenByModel`
   * is what the run.finished event reports, so the cockpit can tell the two
   * kinds of plan apart instead of guessing.
   */
  let plan: TestPlan;
  let writtenByModel: boolean;

  if (!config.anthropicApiKey) {
    // Not an error path: a missing credential is a missing tool. Skipped with a
    // sentence naming the fix, never failed.
    const reason =
      'ANTHROPIC_API_KEY is not set on this deployment, so the Explorer could not ask a model to rank these. Set it and re-run the Explorer for a model-ranked plan.';
    logger.warn({ projectId }, 'no ANTHROPIC_API_KEY — proposing the plan from the crawl');
    publishEvent(orgId, {
      runId: `explore:${projectId}`,
      type: 'log',
      data: { message: `Crawl complete. ${reason}` },
      at: new Date().toISOString(),
    });
    plan = planFromCrawl(flowMap, reason, authProfileChoices, caveats);
    writtenByModel = false;
  } else {
    try {
      plan = (
        await proposePlan(
          llm,
          { orgId, projectId, agent: 'EXPLORER', subjectId: stored.id },
          flowMap,
          { authProfiles: authProfileChoices },
        )
      ).plan;
      writtenByModel = true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const reason = `The Explorer's model call failed (${detail}), so these were read off the crawl instead. The crawl itself succeeded and is stored as flow map v${version}.`;
      logger.error({ err, projectId }, 'the Explorer model call failed; falling back to the crawl');
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message: reason },
        at: new Date().toISOString(),
      });
      plan = planFromCrawl(flowMap, reason, authProfileChoices, caveats);
      writtenByModel = false;
    }
  }

  const testPlan = await prisma.testPlan.create({
    data: {
      orgId,
      projectId,
      flowMapId: stored.id,
      summary: plan.summary,
      skipped: plan.skipped as unknown as object,
      items: {
        create: plan.items.map((item) => ({
          orgId,
          title: item.title,
          rationale: item.rationale,
          feature: item.feature,
          priority: item.priority,
          testType: item.testType,
          steps: item.steps as unknown as object,
          assertions: item.assertions as unknown as object,
          journeyId: item.journeyId,
          authProfileId: item.authProfileId,
        })),
      },
    },
    include: { items: { select: { id: true, testType: true } } },
  });

  logger.info(
    {
      planId: testPlan.id,
      items: testPlan.items.length,
      secretsAvailable: secretNames.length,
      writtenByModel,
    },
    'plan proposed',
  );

  publishEvent(orgId, {
    runId: `explore:${projectId}`,
    type: 'run.finished',
    data: {
      planId: testPlan.id,
      items: testPlan.items.length,
      flowMapVersion: version,
      writtenByModel,
      /*
       * THE APPLIED BUDGET, VISIBLE. The cockpit could not previously tell a
       * deliberate 50-page budget from this build's default, so a customer
       * arguing about a number had nothing to look at. `enumeration` is the
       * other half: a percentage must never be quoted against this denominator
       * without `completeness` beside it.
       */
      budget: {
        pageBudget: outcome.budget.limits.pageBudget,
        maxDepth: outcome.budget.limits.maxDepth,
        perTemplatePageBudget: outcome.budget.limits.perTemplatePageBudget,
        wallClockMillis: outcome.budget.limits.wallClockMillis,
        plan: orgPlan,
        chosenFields: outcome.budget.policy.overridden,
        clampedByPlan: outcome.budget.clamped.map((clamp) => clamp.field),
        defaulted: outcome.budget.policy.defaulted,
      },
      enumeration: {
        completeness: completeness.state,
        /*
         * Logged because it has no column. A re-crawl that detects a different
         * route mode re-keys every state and the version diff reads as a total
         * rewrite, so the value a crawl ran under has to be recoverable — a
         * `FlowMap.routeMode` field is requested, and until it lands this line is
         * the only record.
         */
        routeMode: outcome.routeMode,
        convergence: outcome.outcome,
        atLeastMoreUrls: flowMap.frontier?.atLeastMoreUrls ?? null,
        excludedCount: flowMap.excluded?.length ?? 0,
        tailDiscoveryRate: completeness.tailDiscoveryRate,
        why: completeness.why,
      },
      acceptance: {
        state: acceptance.state,
        reasons: acceptance.reasons,
        degradations: acceptance.degradations.map((entry) => entry.kind),
      },
      merge: mergeReport,
      caveats,
    },
    at: new Date().toISOString(),
  });

  // Onboarding can skip the approval screen; everywhere else a human ticks the
  // boxes before any code is written (§10).
  if (job.autoApprove && testPlan.items.length > 0) {
    await prisma.planItem.updateMany({
      where: { testPlanId: testPlan.id },
      data: { state: 'APPROVED', decidedBy: job.requestedBy, decidedAt: new Date() },
    });
    // Test CODE genuinely needs a model, but the spec-driven types do not:
    // the Generator scaffolds them deterministically from this very crawl
    // (see @qaai/agent's spec-strategies). So without a key the scaffoldable
    // subset is queued and the rest is skipped with the reason — the same
    // fail-open shape the plan itself took above. Code items stay APPROVED
    // and generate the moment a key is present and the plan is approved again.
    if (config.anthropicApiKey) {
      await enqueueGenerate({
        orgId,
        projectId,
        testPlanId: testPlan.id,
        planItemIds: testPlan.items.map((i) => i.id),
        requestedBy: job.requestedBy,
      });
    } else {
      const scaffoldable = testPlan.items.filter((i) =>
        canScaffoldWithoutModel(i.testType as TestType),
      );
      if (scaffoldable.length > 0) {
        await enqueueGenerate({
          orgId,
          projectId,
          testPlanId: testPlan.id,
          planItemIds: scaffoldable.map((i) => i.id),
          requestedBy: job.requestedBy,
        });
      }
      const needModel = testPlan.items.length - scaffoldable.length;
      const message =
        scaffoldable.length > 0
          ? `${testPlan.items.length} item(s) approved. ${scaffoldable.length} spec-driven item(s) were queued to scaffold from the crawl — each carries review flags naming what to fill in. ` +
            (needModel > 0
              ? `The other ${needModel} need a model: ANTHROPIC_API_KEY is not set on this deployment — set it and approve the plan again.`
              : `Set ANTHROPIC_API_KEY to have a model write them outright.`)
          : `${testPlan.items.length} item(s) approved, but no test code was written: ANTHROPIC_API_KEY is not set on this deployment. Set it and approve the plan again.`;
      logger.warn(
        { planId: testPlan.id, items: testPlan.items.length, scaffolded: scaffoldable.length },
        'auto-approve without ANTHROPIC_API_KEY — queued only the deterministic scaffolds',
      );
      publishEvent(orgId, {
        runId: `explore:${projectId}`,
        type: 'log',
        data: { message },
        at: new Date().toISOString(),
      });
    }
  }
}
