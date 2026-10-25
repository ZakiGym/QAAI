/**
 * THE THIRD ENUMERATION SOURCE: what real users actually did.
 *
 * A crawl reports what it REACHED. A source detector reports what the
 * repository DECLARES. This file reports what people DO — including the paths
 * nothing in the repo suggests and no crawler would find, because they depend
 * on data only production has. It is the only one of the three whose evidence
 * is a human having walked the thing.
 *
 * Five endpoints, and the split between them is the same one the rest of the
 * product uses: analysis is deterministic, fast and answered in the request;
 * generation calls a model and goes on the queue.
 *
 *   POST /traffic/:projectId/analyze   upload → ranked journeys, frequencies,
 *                                      coverage against the existing suite, an
 *                                      itemised account of what was stripped,
 *                                      AND a durable `TrafficIngest` +
 *                                      `ObservedJourney` + `CoverageItem` write
 *   POST /traffic/:projectId/propose   chosen journeys → approved plan items →
 *                                      the Generator writes the tests
 *   GET  /traffic/:projectId/cross-reference
 *                                      the three buckets: covered-and-hot,
 *                                      uncovered-and-hot, covered-and-cold
 *   GET  /traffic/:projectId/connectors        live-traffic connectors + sync state
 *   POST /traffic/:projectId/connectors/:integrationId/sync
 *                                      pull a window through the connector
 *
 * ── WHY THE PERSISTENCE IS THE FEATURE, NOT THE PLUMBING ────────────────────
 *
 * `/analyze` used to compute observed journeys, real session frequencies and a
 * coverage cross-reference and then throw all three away with the HTTP
 * response. The one source that knows which 20 of 412 routes carry 95% of real
 * sessions could not inform anything: not the ranking of what to test next, not
 * the denominator, not the "your suite spends its time on a page nobody visits"
 * report. Every number below is now written down, with the window it was
 * measured in and every cap that bit while measuring it.
 *
 * ── THE ASYMMETRY THAT GOVERNS EVERY CONCLUSION HERE ────────────────────────
 *
 * Traffic is EVIDENCE OF PRESENCE AND NEVER EVIDENCE OF ABSENCE. A route in a
 * log exists. A route missing from a log may simply not have been sampled, or
 * not have been walked in that window, or have been walked by the one user
 * whose session the RUM provider dropped. So:
 *
 *   · traffic ADDS to the registry and never retires from it;
 *   · "uncovered and hot" is a sound conclusion — the journey was observed;
 *   · "covered and cold" is NOT sound from a sampled source, and the
 *     cross-reference refuses to draw it rather than shipping a sentence that
 *     tells a customer to delete a test their users do walk.
 *
 * ── WHAT THIS FILE IS CAREFUL ABOUT ─────────────────────────────────────────
 *
 * 1. NOTHING RAW IS EVER PERSISTED. `analyzeTraffic` redacts on ingest and this
 *    route never sees the upload again after handing it over — the request body
 *    is not written anywhere, not to a row, not to the audit log, not to a log
 *    line. The audit entry records counts and never content.
 *
 * 2. THE CLIENT'S JOURNEYS ARE UNTRUSTED INPUT ON THE WAY BACK. /propose takes
 *    journeys that have been through a browser, so every route is re-sanitised
 *    here and the journey id is recomputed from the sanitised steps. If the two
 *    disagree, the steps were edited after the analysis — which is exactly what
 *    a raw production path smuggled into the plan would look like — and the
 *    request is refused rather than quietly persisted.
 *
 * 3. COVERAGE IS RECOMPUTED SERVER-SIDE. A client claiming a journey is
 *    uncovered does not make it so; the suite may have changed since /analyze,
 *    and "we already test this" is a claim only the database can make.
 *
 * 4. GENERATION FAILS FAST WHEN IT CANNOT SUCCEED. The Generator needs a Flow
 *    Map for real locators, so a project that has never been crawled is told
 *    that here, in a 422, instead of enqueuing a job that dies in the worker
 *    where nobody is watching.
 *
 * 5. EVERY CAP THAT BIT IS REPORTED AS A COUNT AND AS A REASON. Four caps
 *    apply on this path — the entry limit, the journey-ranking limit, the
 *    suite-comparison limit and the persistence limit — and all four used to be
 *    silent. An undisclosed cap on an ingest makes a coverage percentage go UP,
 *    because the surfaces it drops are surfaces nothing then counts. The
 *    suite-comparison limit is the dangerous one: with more than
 *    `MAX_TESTS_COMPARED` tests in the project, a journey reported UNCOVERED
 *    might be covered by test 501, so the cross-reference marks its own verdict
 *    as a lower bound rather than a fact.
 *
 * 6. A CONNECTOR THAT HAS NEVER RUN IS NOT AN APPLICATION WITH NO TRAFFIC.
 *    `NEVER_SYNCED` and "zero sessions observed" are opposite facts and only
 *    one of them is bad news for the customer, so they are different values —
 *    see {@link ConnectorSyncState}.
 */

import { Router, text } from 'express';
import { z } from 'zod';
import { QUEUE_NAMES, originFromSources, type SurfaceKind, type SurfaceSource } from '@qaai/shared';
import {
  TrafficFormatError,
  analyzeTraffic,
  canonicalRoute,
  crossReferenceSteps,
  journeyIdOf,
  journeyToPlanItem,
  sanitisePath,
  type ExistingTest,
  type Journey,
  type TrafficAnalysis,
  type TrafficFormat,
} from '@qaai/agent';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { openToken } from '../lib/integrations.js';
import { actorOf, requireAuth, requireRole } from '../middleware/auth.js';

export const trafficRouter: Router = Router();

trafficRouter.use(requireAuth);

/**
 * The global JSON parser is capped at 2MB, which a week of access logs will
 * exceed on its own. Text uploads are parsed here instead, with their own
 * limit: `express.json` ignores these content types, so the two do not fight.
 *
 * A large HAR should therefore be posted as `text/plain` or
 * `application/har+json` rather than `application/json` — the parser sniffs the
 * shape either way, so the content type only decides which body parser runs.
 */
const UPLOAD_LIMIT = '24mb';
trafficRouter.use(
  ['/traffic/:projectId/analyze'],
  text({
    type: [
      'text/plain',
      'text/*',
      'application/x-ndjson',
      'application/har+json',
      'application/octet-stream',
    ],
    limit: UPLOAD_LIMIT,
  }),
);

/**
 * Lower than the module's own cap. The analysis is synchronous, so this bound
 * is really a bound on how long one request may hold the event loop; a bigger
 * upload is still accepted, it is just analysed as its first 50k entries and
 * says so in `warnings`.
 */
const API_MAX_ENTRIES = 50_000;
/**
 * Enough of the suite to cross-reference against without reading a book.
 *
 * THE MOST DANGEROUS NUMBER IN THIS FILE. A project with 900 tests has its
 * journeys compared against 500 of them, so every `UNCOVERED` verdict is a
 * claim about a subset dressed as a claim about the suite. It is now counted
 * and named — `SUITE_COMPARISON` in {@link TRAFFIC_CAPS} — and the
 * cross-reference downgrades its own certainty when it bit.
 */
const MAX_TESTS_COMPARED = 500;
const MAX_JOURNEYS_PROPOSED = 20;
/**
 * Journeys written to `ObservedJourney` per ingest.
 *
 * Higher than `MAX_JOURNEYS_PROPOSED` on purpose: proposing is a human reading
 * a list, enumerating is a denominator, and the denominator should not be the
 * narrower of the two. Anything beyond this is reported as an exact dropped
 * count, because unlike the ranker's cap this one is applied here where the
 * candidates can be counted.
 */
const MAX_JOURNEYS_STORED = 200;
/**
 * Routes and endpoints merged into the surface registry per ingest.
 *
 * A week of logs from a large app can name thousands of distinct templates, and
 * a single HTTP request must not turn into an unbounded write. When it bites it
 * is reported, and the routes it dropped were the LEAST frequent ones — so the
 * registry loses the tail, never the hot paths.
 */
const MAX_SURFACE_WRITES = 500;

// ─── Caps: named, so they can be disclosed ───────────────────────────────────

/**
 * Every cap that can bite on the traffic path.
 *
 * Named because an anonymous cap cannot be disclosed, and an undisclosed cap on
 * an ingest is the quiet way a coverage percentage goes up: the surfaces it
 * drops stop being uncovered and start being absent, and absent costs nothing.
 *
 * Deliberately NOT `CrawlCap` from flow-map.ts. That vocabulary is about a
 * crawl — page budgets, depth, frontier queues — and three of these four have
 * no crawl analogue at all. Borrowing its names would put "the depth limit"
 * next to an access log, which is the kind of wrong label that teaches a reader
 * to stop reading the label.
 */
export const TRAFFIC_CAPS = [
  /** `maxEntries`: the parser stopped and the rest of the upload was not read. */
  'ENTRY_LIMIT',
  /** `maxJourneys`: the ranker returned its top N and discarded the rest. */
  'JOURNEY_RANKING',
  /** `MAX_TESTS_COMPARED`: coverage was decided against part of the suite. */
  'SUITE_COMPARISON',
  /** `MAX_JOURNEYS_STORED`: ranked journeys that were not written down. */
  'JOURNEY_PERSISTENCE',
  /** `MAX_SURFACE_WRITES`: observed routes not merged into the registry. */
  'SURFACE_PERSISTENCE',
  /**
   * The row limit WE sent to a connector's own API, which the provider
   * truncated its answer to.
   *
   * Its own member rather than a second SURFACE_PERSISTENCE row, because the
   * two have different causes and different remedies and were being reported
   * under one name: SURFACE_PERSISTENCE is surface we HELD and did not write,
   * fixed by raising the write limit, while this is surface we never read at
   * all because the request asked for N pages — fixed by asking for more, or
   * by paging. A reader summing one label's `discarded` across both got a
   * number that is neither.
   */
  'PROVIDER_ROW_LIMIT',
] as const;
export type TrafficCap = (typeof TRAFFIC_CAPS)[number];

/**
 * Compile-time presence record. See the note on {@link TRAFFIC_CONNECTOR_CONFIG_PRESENT}
 * for why this codebase insists on both halves of the guard.
 */
const TRAFFIC_CAP_PRESENT: Record<TrafficCap, string> = {
  ENTRY_LIMIT: 'the upload-entry limit',
  JOURNEY_RANKING: 'the journey-ranking limit',
  SUITE_COMPARISON: 'the suite-comparison limit',
  JOURNEY_PERSISTENCE: 'the stored-journey limit',
  SURFACE_PERSISTENCE: 'the merged-surface limit',
  PROVIDER_ROW_LIMIT: 'the row limit asked of the provider',
};

export const TRAFFIC_CAP_LABELS: Readonly<Record<TrafficCap, string>> = TRAFFIC_CAP_PRESENT;

/**
 * One cap, and what it cost.
 *
 * `discarded` is the number that matters and `discardedIsExact` is the field
 * that keeps it honest. "The ranking limit bit" is a fact about us; "it bit and
 * discarded 61 journeys" is a fact about how wrong the number is. Where the
 * producer genuinely cannot count what it threw away — `rankJourneys` returns
 * its survivors and never says how many groups it had — `discarded` is the
 * FLOOR and `discardedIsExact` is false, so a report can say "at least one
 * more" without implying it knows the figure.
 *
 * Never omitted when a cap bit, and never present when it did not: a cap that
 * did not bite is not a caveat.
 */
export interface TrafficCapBite {
  cap: TrafficCap;
  /** The limit as applied. */
  limit: number;
  /** How many times it stopped something. */
  bites: number;
  /** What it cost, exactly or as a floor. See `discardedIsExact`. */
  discarded: number;
  /** False when `discarded` is a lower bound rather than a measurement. */
  discardedIsExact: boolean;
  /** The sentence the report prints. */
  reason: string;
}

/** Only the caps that actually bit. */
function bitingCaps(caps: readonly TrafficCapBite[]): TrafficCapBite[] {
  return caps.filter((cap) => cap.bites > 0);
}

trafficRouter.post('/traffic/:projectId/analyze', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  const project = await loadProject(projectId);

  const { payload, inline } = readUpload(req.body);
  const options = optionsFrom(inline, req.query);
  const suite = await loadSuite(projectId);
  const maxJourneys = options.maxJourneys ?? 25;

  let analysis;
  try {
    analysis = analyzeTraffic(payload, {
      format: options.format ?? 'AUTO',
      maxEntries: API_MAX_ENTRIES,
      maxJourneys,
      existingTests: suite.tests,
      ...(options.sessionGapMinutes ? { sessionGapMs: options.sessionGapMinutes * 60_000 } : {}),
      ...(options.includeStaticAssets !== undefined
        ? { includeStaticAssets: options.includeStaticAssets }
        : {}),
      ...(options.includeBots !== undefined ? { includeBots: options.includeBots } : {}),
    });
  } catch (err) {
    // A format we cannot read is the caller's problem to fix and the message
    // names the accepted shapes — it must not surface as an opaque 500.
    if (err instanceof TrafficFormatError) throw badRequest(err.message);
    throw err;
  }

  /*
   * ENUMERATION IS NOW PERSISTED, AND THIS IS THE POINT OF THE ENDPOINT.
   *
   * Everything above used to be computed and discarded with the response, so
   * the one source that knows which 20 of 412 routes carry 95% of real sessions
   * could inform nothing. The journeys, their frequencies, the window they were
   * measured in, every cap that bit, and the routes and endpoints themselves
   * are written down here — the surface going into `CoverageItem`, which IS the
   * registry, with TRAFFIC named in `sources`.
   *
   * Still true after this write: no request content is stored. A journey is
   * parameterised route templates, counts and timestamps, all produced by the
   * ingest redactor before a `TrafficEvent` existed.
   */
  const caps = analysisCaps({
    analysis,
    maxJourneys,
    suiteCompared: suite.tests.length,
    suiteTotal: suite.total,
  });
  const persisted = await persistIngest({
    orgId: actor.orgId,
    projectId: project.id,
    environmentId: options.environmentId ?? null,
    format: analysis.format,
    integrationId: null,
    requestedBy: actor.userId,
    analysis,
    caps,
  });

  // Counts only. The upload is not written here, to the audit log, or anywhere
  // else — and it is not retained after this handler returns.
  await audit({
    actor,
    action: 'traffic.analyze',
    targetType: 'Project',
    targetId: project.id,
    metadata: {
      format: analysis.format,
      requests: analysis.totals.requests,
      sessions: analysis.totals.sessions,
      journeys: analysis.journeys.length,
      skipped: analysis.totals.skipped,
      redacted: analysis.redaction.counts,
      ingestId: persisted.ingestId,
      journeysStored: persisted.journeysStored,
      surfaceMerged: persisted.surface.created + persisted.surface.updated,
      surfaceReinstated: persisted.surface.reinstated,
      capsThatBit: bitingCaps(caps).map((cap) => cap.cap),
    },
  });

  res.json({
    format: analysis.format,
    window: analysis.window,
    totals: analysis.totals,
    redaction: analysis.redaction,
    parameterisation: analysis.parameterisation,
    identityBreakdown: analysis.identityBreakdown,
    warnings: analysis.warnings,
    journeys: analysis.journeys,
    /**
     * What was written down, so the response is auditable against the rows.
     * Additive: every field the cockpit already reads is unchanged above.
     */
    enumeration: {
      ingestId: persisted.ingestId,
      journeysStored: persisted.journeysStored,
      journeysNotStored: persisted.journeysDropped,
      surfaceCreated: persisted.surface.created,
      surfaceUpdated: persisted.surface.updated,
      /**
       * Retired registry rows this ingest brought back.
       *
       * The upsert clears `retiredAt`, so observing a retired surface again
       * returns it to the denominator. That is the right call — a real session
       * walked it — but it is a denominator growing, and growing in silence is
       * how a number changes for a reason nobody can find.
       */
      surfaceReinstated: persisted.surface.reinstated,
      surfaceNotStored: persisted.surface.dropped,
      /**
       * Upload traffic is a file somebody chose, so its sampling rate is
       * unknown unless they say — and unknown is not 1. Nothing downstream may
       * read a route's absence from this upload as absence from production.
       */
      samplingRate: null,
      mayConcludeAbsence: false,
      /** Every cap that bit, as a count AND a reason. Empty means none did. */
      capsThatBit: bitingCaps(caps),
    },
    /** What /propose expects back, so the client does not have to guess. */
    next: {
      endpoint: `/traffic/${project.id}/propose`,
      send: 'the journeys you want tests for, unmodified, plus totalSessions and source',
    },
  });
});

// ─── Persisting the third enumeration source ─────────────────────────────────

/**
 * How an observed route enters the surface registry.
 *
 * `CoverageItem` IS the registry — there is no second inventory and nothing
 * here mints one. A route real users walked becomes a `ROUTE` item and an HTTP
 * operation becomes an `ENDPOINT` item, both with `TRAFFIC` in `sources`, and
 * `origin` DERIVED from that set with `originFromSources` rather than set by
 * hand. Setting both independently is how an item comes to carry two
 * provenance fields that disagree while only one of them is on screen.
 */
interface ObservedSurfaceWrite {
  kind: SurfaceKind;
  key: string;
  label: string;
  evidence: string;
  /** Sessions observed on it, for the ranking and for the cross-reference. */
  sessions: number;
}

/**
 * Merges observed surface into the registry — ADDING ONLY.
 *
 * Traffic never retires anything, and the asymmetry is the reason: a route
 * absent from a window of logs may be unsampled, or seasonal, or walked by one
 * user yesterday. Retiring on traffic's silence would delete real surface from
 * the denominator and raise the percentage, which is the exact move this
 * product exists not to make.
 *
 * An existing row keeps its `file`, `line` and `detector` — the source detector
 * knows where the route is declared and traffic does not, so overwriting those
 * with nulls would blind the editor link on every route that has both
 * declarers. What traffic contributes to an existing row is its own name in
 * `sources`, the derived `origin`, and the sentence saying it was observed.
 */
async function mergeObservedSurface(input: {
  orgId: string;
  projectId: string;
  environmentId: string | null;
  writes: readonly ObservedSurfaceWrite[];
}): Promise<{ created: number; updated: number; reinstated: number }> {
  const { orgId, projectId, environmentId, writes } = input;
  if (writes.length === 0) return { created: 0, updated: 0, reinstated: 0 };

  const existing = await prisma.coverageItem.findMany({
    where: { projectId, key: { in: writes.map((write) => write.key) } },
    /*
     * `retiredAt` is selected because the upsert's `update` clears it, and a
     * row coming BACK into the denominator is a fact the response has to
     * carry. Somebody retired that surface on purpose; traffic observing it
     * again is good evidence that the decision is stale, and it is also a
     * denominator that grew for a reason nobody could find in any number this
     * endpoint returned. Counted, not silent — the same rule
     * POST /api-surface reports as REINSTATED.
     */
    select: { key: true, sources: true, retiredAt: true },
  });
  const sourcesByKey = new Map<string, SurfaceSource[]>();
  const retiredKeys = new Set<string>();
  for (const row of existing) {
    if (row.retiredAt !== null) retiredKeys.add(row.key);
    // `sources` is `Json?` with three meaningful states: absent means the row
    // predates the column and nobody recorded a declarer, which is NOT the
    // same as an empty list and must not be turned into one silently. Either
    // way TRAFFIC is now a declarer, so the union is what gets written.
    const stored = Array.isArray(row.sources) ? (row.sources as SurfaceSource[]) : [];
    sourcesByKey.set(row.key, stored);
  }

  let created = 0;
  let updated = 0;
  let reinstated = 0;
  const CHUNK = 100;
  for (let offset = 0; offset < writes.length; offset += CHUNK) {
    const chunk = writes.slice(offset, offset + CHUNK);
    await prisma.$transaction(
      chunk.map((write) => {
        const before = sourcesByKey.get(write.key);
        const sources = [...new Set<SurfaceSource>([...(before ?? []), 'TRAFFIC'])];
        const origin = originFromSources(sources);
        if (before === undefined) created += 1;
        else updated += 1;
        if (retiredKeys.has(write.key)) reinstated += 1;

        const shared = {
          sources: sources as unknown as object,
          /*
           * `originFromSources` cannot return null here — the set contains
           * TRAFFIC — but the fallback is written rather than asserted away,
           * because `origin` is a required column and a `!` here would be a
           * silent landmine if the derivation ever gained an early return.
           */
          origin: origin ?? ('CRAWL_ONLY' as const),
          /*
           * The environment this was OBSERVED in. Null when the uploader did
           * not say, which is honest: a log file usually does not carry one,
           * and defaulting it to production would put staging traffic in a
           * production denominator and invent uncovered production gaps.
           */
          environmentId,
          /*
           * Exercisable: a real user drove it, so our harness provably can.
           * This is the one declarer that can assert exercisability from
           * evidence rather than from a policy guess.
           */
          exercisability: 'EXERCISABLE' as const,
          exerciseDetail: 'A real session walked this surface, so a test can drive it.',
          retiredAt: null,
        };

        return prisma.coverageItem.upsert({
          where: { projectId_key: { projectId, key: write.key } },
          create: {
            ...shared,
            orgId,
            projectId,
            key: write.key,
            kind: write.kind,
            label: write.label,
            evidence: write.evidence,
            detector: 'traffic-ingest',
            meta: { observedSessions: write.sessions },
          },
          /*
           * `file`, `line` and `detector` are deliberately absent from the
           * update. A source detector knows the file a route is declared in and
           * traffic does not; writing null over it would blind the editor link
           * on exactly the routes that have both declarers — the best-evidenced
           * rows in the table.
           */
          update: {
            ...shared,
            label: write.label,
            evidence: write.evidence,
            meta: { observedSessions: write.sessions },
          },
        });
      }),
    );
  }
  return { created, updated, reinstated };
}

/**
 * The observed surface a set of journeys names, strongest-first.
 *
 * Sessions are summed per route across journeys, so the cap below drops the
 * tail and never the hot paths. Endpoints are minted only for a non-GET
 * method or a path that looks like an API: a GET of `/orders` is the route, and
 * minting `ENDPOINT:GET /orders` beside it would double-count one surface on
 * two axes and inflate the denominator with a row nobody can test separately.
 */
function surfaceFromJourneys(journeys: readonly Journey[]): ObservedSurfaceWrite[] {
  const routes = new Map<string, { route: string; sessions: number }>();
  const endpoints = new Map<string, { method: string; route: string; sessions: number }>();

  for (const journey of journeys) {
    for (const step of journey.steps) {
      const route = canonicalRoute(step.route);
      const routeEntry = routes.get(route);
      if (routeEntry) routeEntry.sessions += journey.sessionCount;
      else routes.set(route, { route, sessions: journey.sessionCount });

      const method = step.method.toUpperCase();
      const looksLikeApi = method !== 'GET' || /^\/(api|graphql|v\d)(\/|$)/.test(route);
      if (!looksLikeApi) continue;
      const key = `${method} ${route}`;
      const endpointEntry = endpoints.get(key);
      if (endpointEntry) endpointEntry.sessions += journey.sessionCount;
      else endpoints.set(key, { method, route, sessions: journey.sessionCount });
    }
  }

  const writes: ObservedSurfaceWrite[] = [
    ...[...routes.values()].map((entry): ObservedSurfaceWrite => ({
      kind: 'ROUTE',
      key: `ROUTE:${entry.route}`,
      label: entry.route,
      evidence:
        `Walked by ${entry.sessions} real session${entry.sessions === 1 ? '' : 's'} in the ` +
        'uploaded window. Observed, not declared — no route table had to name it.',
      sessions: entry.sessions,
    })),
    ...[...endpoints.values()].map((entry): ObservedSurfaceWrite => ({
      kind: 'ENDPOINT',
      key: `ENDPOINT:${entry.method} ${entry.route}`,
      label: `${entry.method} ${entry.route}`,
      evidence:
        `Called by ${entry.sessions} real session${entry.sessions === 1 ? '' : 's'} in the ` +
        'uploaded window.',
      sessions: entry.sessions,
    })),
  ];

  // Hottest first, so a cap that bites drops the tail.
  return writes.sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}

/** The same, for a totals-shaped source that has routes but no ordering. */
function surfaceFromRouteTotals(
  rows: readonly { route: string; sessions: number }[],
  provider: TrafficConnectorProvider,
): ObservedSurfaceWrite[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const route = canonicalRoute(sanitiseRoute(row.route));
    merged.set(route, (merged.get(route) ?? 0) + row.sessions);
  }
  return [...merged.entries()]
    .map(([route, sessions]): ObservedSurfaceWrite => ({
      kind: 'ROUTE',
      key: `ROUTE:${route}`,
      label: route,
      evidence:
        `${provider} reported ${sessions} session${sessions === 1 ? '' : 's'} on this page in ` +
        'the connector window. A totals source carries no ordering, so this route is enumerated ' +
        'and ranked but belongs to no journey.',
      sessions,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key));
}

/**
 * A provider-supplied path through the same redaction the upload path uses.
 *
 * GA4 hands back real `pagePath` values, which means real ids and sometimes
 * real email addresses in a path segment. Nothing that skipped `sanitisePath`
 * may reach a stored row, and a connector is not an exception to that.
 */
function sanitiseRoute(raw: string): string {
  const { segments } = sanitisePath(raw);
  if (segments.length === 0) return '/';
  return `/${segments.map((segment) => segment.text.replace(/^[{<](.+)[}>]$/, ':$1')).join('/')}`;
}

/**
 * Writes an ingest, its journeys and its observed surface.
 *
 * One function for both the upload path and the connector path on purpose: two
 * implementations of "what does an ingest record" is how two screens come to
 * report two different numbers for one application.
 */
async function persistIngest(input: {
  orgId: string;
  projectId: string;
  environmentId: string | null;
  format: TrafficFormat;
  integrationId: string | null;
  requestedBy: string | null;
  analysis: Pick<TrafficAnalysis, 'totals' | 'window' | 'journeys'>;
  caps: readonly TrafficCapBite[];
}): Promise<{
  ingestId: string;
  journeysStored: number;
  journeysDropped: number;
  surface: { created: number; updated: number; reinstated: number; dropped: number };
}> {
  const { orgId, projectId, environmentId, format, integrationId, requestedBy, analysis } = input;

  const stored = analysis.journeys.slice(0, MAX_JOURNEYS_STORED);
  const journeysDropped = analysis.journeys.length - stored.length;

  const caps: TrafficCapBite[] = [...input.caps];
  if (journeysDropped > 0) {
    caps.push({
      cap: 'JOURNEY_PERSISTENCE',
      limit: MAX_JOURNEYS_STORED,
      bites: 1,
      discarded: journeysDropped,
      // Exact: the candidates were in hand and counted here.
      discardedIsExact: true,
      reason:
        `The ranking produced ${analysis.journeys.length} journeys and the ${MAX_JOURNEYS_STORED} ` +
        'most-walked were stored. The rest are in this response and were not written down — and ' +
        'because the observed surface below is read from the STORED journeys, a route that only ' +
        'the dropped journeys walked is not in the registry either.',
    });
  }

  const allSurface = surfaceFromJourneys(stored);
  const surfaceWrites = allSurface.slice(0, MAX_SURFACE_WRITES);
  const surfaceDropped = allSurface.length - surfaceWrites.length;
  if (surfaceDropped > 0) {
    caps.push({
      cap: 'SURFACE_PERSISTENCE',
      limit: MAX_SURFACE_WRITES,
      bites: 1,
      discarded: surfaceDropped,
      discardedIsExact: true,
      reason:
        `${allSurface.length} distinct routes and endpoints were observed and the ` +
        `${MAX_SURFACE_WRITES} most-walked were merged into the surface registry. At least ` +
        `${surfaceDropped} more real surfaces exist and are not yet counted.`,
    });
  }

  const ingest = await prisma.trafficIngest.create({
    data: {
      orgId,
      projectId,
      environmentId,
      format,
      integrationId,
      requestedBy,
      /*
       * From the ENTRIES and never from the clock. A log uploaded today may
       * describe last month, and stamping it with `now` would make a stale
       * window look fresh — which is the precise failure a connector's sync
       * time exists to prevent.
       */
      observedFrom: analysis.window ? new Date(analysis.window.from) : null,
      observedTo: analysis.window ? new Date(analysis.window.to) : null,
      entriesParsed: analysis.totals.parsed,
      entriesSkipped: analysis.totals.skipped,
      sessions: analysis.totals.sessions,
      journeysStored: stored.length,
      journeysDroppedByCap: journeysDropped,
      // Only the caps that bit. A cap that did not bite is not a caveat, and an
      // empty list here means "none did" — which is a far better fact than an
      // empty list because nobody looked.
      capsThatBit: bitingCaps(caps).map((cap) => ({ ...cap })),
    },
    select: { id: true },
  });

  for (const journey of stored) {
    const data = {
      orgId,
      projectId,
      ingestId: ingest.id,
      name: journey.name,
      feature: journey.feature,
      steps: journey.steps as unknown as object,
      sessionCount: journey.sessionCount,
      sessionShare: journey.sessionShare,
      requestCount: journey.requestCount,
      errorRate: journey.errorRate,
      /*
       * Null and not 0 when the source carried no timings: 0 would read as
       * "this journey completes instantly", which is a measurement nobody made.
       */
      medianDurationMs:
        journey.medianDurationMs === null ? null : Math.round(journey.medianDurationMs),
      lastObservedAt: new Date(journey.lastSeen),
      coverageStatus: journey.coverage.status,
      matchedRatio: journey.coverage.matchedRatio,
      missingSteps: journey.coverage.missingSteps as unknown as object,
    };
    await prisma.observedJourney.upsert({
      where: { projectId_journeyKey: { projectId, journeyKey: journey.id } },
      create: { ...data, journeyKey: journey.id, firstObservedAt: new Date(journey.firstSeen) },
      update: {
        ...data,
        // `firstObservedAt` is never moved forward: the earliest sighting is a
        // fact about the journey, and a later upload describing a later window
        // must not make a journey look newer than it is.
        ingestCount: { increment: 1 },
      },
    });
  }

  const surface = await mergeObservedSurface({
    orgId,
    projectId,
    environmentId,
    writes: surfaceWrites,
  });

  return {
    ingestId: ingest.id,
    journeysStored: stored.length,
    journeysDropped,
    surface: { ...surface, dropped: surfaceDropped },
  };
}

/**
 * The caps the ANALYSIS itself hit, before anything was stored.
 *
 * `JOURNEY_RANKING` is the one that cannot be counted exactly, and it says so.
 * `rankJourneys` returns its survivors and never reports how many distinct
 * session signatures it grouped, so when the cap bit all that is honestly
 * knowable is "at least one more journey existed" — which is why `discarded` is
 * 1 and `discardedIsExact` is false. Reporting 0 would say the cap cost
 * nothing; inventing a figure would be worse.
 */
function analysisCaps(input: {
  analysis: Pick<TrafficAnalysis, 'totals' | 'journeys'>;
  maxJourneys: number;
  suiteCompared: number;
  suiteTotal: number;
}): TrafficCapBite[] {
  const caps: TrafficCapBite[] = [];
  if (input.analysis.totals.truncated) {
    caps.push({
      cap: 'ENTRY_LIMIT',
      limit: API_MAX_ENTRIES,
      bites: 1,
      /*
       * A FLOOR OF ONE, not zero, and it is the same rule JOURNEY_RANKING
       * below states: `discarded: 0` with `discardedIsExact: false` reads as
       * "at least nothing", which is the sentence "the cap cost nothing" — and
       * this cap only appears here because the parser stopped with entries
       * left, so at least one entry was not read. The parser does not count
       * what it never looked at, so one is all that is knowable and inventing
       * a bigger figure would be the same sin in the other direction.
       */
      discarded: 1,
      discardedIsExact: false,
      reason:
        `Parsing stopped after ${API_MAX_ENTRIES} entries, so this describes a prefix of the ` +
        'upload: at least one more entry was in it and was not read. The parser does not read ' +
        'past the limit, so how many it skipped is not known — only that there were some.',
    });
  }
  if (input.analysis.journeys.length >= input.maxJourneys) {
    caps.push({
      cap: 'JOURNEY_RANKING',
      limit: input.maxJourneys,
      bites: 1,
      discarded: 1,
      discardedIsExact: false,
      reason:
        `The ranking returned its limit of ${input.maxJourneys} journeys, so at least one more ` +
        'distinct journey was walked and is not in this list. The ranker does not report how many ' +
        'it grouped, so this is a floor and not a count.',
    });
  }
  if (input.suiteTotal > input.suiteCompared) {
    caps.push({
      cap: 'SUITE_COMPARISON',
      limit: MAX_TESTS_COMPARED,
      bites: 1,
      discarded: input.suiteTotal - input.suiteCompared,
      discardedIsExact: true,
      reason:
        `Coverage was decided against ${input.suiteCompared} of this project’s ${input.suiteTotal} ` +
        'tests. Every UNCOVERED verdict below is therefore an upper bound on the gap: one of the ' +
        `${input.suiteTotal - input.suiteCompared} tests that were not compared may already cover it.`,
    });
  }
  return caps;
}

// ─── Analyze ─────────────────────────────────────────────────────────────────

const analyzeOptionsSchema = z.object({
  format: z.enum(['HAR', 'ACCESS_LOG', 'OTLP', 'AUTO']).optional(),
  sessionGapMinutes: z.coerce
    .number()
    .min(1)
    .max(24 * 60)
    .optional(),
  maxJourneys: z.coerce.number().int().min(1).max(40).optional(),
  includeStaticAssets: z.coerce.boolean().optional(),
  includeBots: z.coerce.boolean().optional(),
  /**
   * Which environment this traffic came from.
   *
   * Optional and NOT defaulted to production. A log file rarely says, and
   * stamping an unlabelled upload with the production environment would put
   * staging routes in a production denominator — reported back as uncovered
   * production gaps that do not exist.
   */
  environmentId: z.string().min(1).max(64).optional(),
});

type AnalyzeOptionsInput = z.infer<typeof analyzeOptionsSchema>;

/**
 * Accepts the upload three ways, because three different clients send it three
 * different ways: a raw text body (curl piping a log file), a JSON envelope
 * `{ content, ...options }` (the cockpit), or the HAR/OTLP document itself as
 * the JSON body (anything scripted against the API).
 */
function readUpload(body: unknown): { payload: string | Record<string, unknown>; inline: unknown } {
  if (typeof body === 'string') {
    if (!body.trim()) throw badRequest('The upload is empty.');
    return { payload: body, inline: {} };
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.content === 'string') {
      if (!record.content.trim()) throw badRequest('`content` is empty.');
      return { payload: record.content, inline: record };
    }
    if (record.log !== undefined || record.resourceSpans !== undefined) {
      return { payload: record, inline: {} };
    }
  }
  throw badRequest(
    'Upload traffic as a text body (access logs, NDJSON), as `{ content: "…" }`, or as the HAR ' +
      'or OTLP document itself. Nothing recognisable was in the body.',
  );
}

function optionsFrom(inline: unknown, query: unknown): AnalyzeOptionsInput {
  const merged = { ...(query as object), ...(inline as object) };
  const parsed = analyzeOptionsSchema.safeParse(merged);
  if (!parsed.success) {
    throw badRequest('Invalid analysis options', parsed.error.flatten().fieldErrors);
  }
  return parsed.data;
}

async function loadProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * The suite to cross-reference against, and how much of it that was.
 *
 * `total` is a second query and earns it: without it the `take` above is an
 * undisclosed cap, and an undisclosed cap on the thing in the DENOMINATOR of
 * "is this journey covered" makes the uncovered list longer than the truth.
 * Both numbers are returned so the caller can say which.
 */
async function loadSuite(projectId: string): Promise<{
  tests: ExistingTest[];
  total: number;
}> {
  const [rows, total] = await Promise.all([
    prisma.test.findMany({
      where: { projectId, disabledAt: null },
      select: { id: true, name: true, code: true, filePath: true, spec: true },
      take: MAX_TESTS_COMPARED,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.test.count({ where: { projectId, disabledAt: null } }),
  ]);
  return {
    tests: rows.map((test) => ({
      id: test.id,
      name: test.name,
      code: test.code,
      filePath: test.filePath,
      spec: test.spec,
    })),
    total,
  };
}

// ─── Propose ─────────────────────────────────────────────────────────────────

const stepSchema = z.object({
  method: z.string().min(1).max(16),
  route: z.string().min(1).max(512),
  status: z.number().int().nullable().optional(),
  errorRate: z.number().min(0).max(1).optional(),
  count: z.number().int().min(0).optional(),
  repeats: z.number().int().min(0).optional(),
});

const journeySchema = z.object({
  id: z.string().min(4).max(64),
  name: z.string().max(240).optional(),
  feature: z.string().max(80).optional(),
  steps: z.array(stepSchema).min(1).max(40),
  sessionCount: z.number().int().min(0),
  sessionShare: z.number().min(0).max(1),
  containingSessionCount: z.number().int().min(0).optional(),
  containingSessionShare: z.number().min(0).max(1).optional(),
  requestCount: z.number().int().min(0),
  errorRate: z.number().min(0).max(1).optional(),
  firstSeen: z.string().max(40),
  lastSeen: z.string().max(40),
  contentKind: z.enum(['html', 'json', 'other', 'mixed', 'unknown']).optional(),
  medianDurationMs: z.number().nullable().optional(),
});

const proposeSchema = z.object({
  journeys: z.array(journeySchema).min(1).max(MAX_JOURNEYS_PROPOSED),
  /** Denominator behind every percentage, from the analysis that produced these. */
  totalSessions: z.number().int().min(1),
  source: z.enum(['HAR', 'ACCESS_LOG', 'OTLP']),
  testType: z.enum(['E2E', 'API', 'SMOKE', 'INTEGRATION']).optional(),
  /** Propose anyway for journeys the suite already covers. Off by default. */
  includeCovered: z.boolean().optional(),
});

/**
 * Re-sanitises a client-supplied journey and proves it came from an analysis.
 *
 * Every route goes back through the ingest classifier, and the journey id is
 * recomputed from the result. A journey that survived the round trip unchanged
 * hashes to the id it arrived with; one whose routes were edited — which is
 * what a raw production path smuggled into the plan looks like — does not, and
 * is refused. That makes the id an integrity check rather than a label.
 */
function resanitise(journey: z.infer<typeof journeySchema>): {
  ok: boolean;
  steps: Array<{
    method: string;
    route: string;
    status: number | null;
    errorRate: number;
    count: number;
    repeats: number;
  }>;
} {
  const steps = journey.steps.map((step) => {
    const { segments } = sanitisePath(step.route);
    const route =
      segments.length === 0
        ? '/'
        : `/${segments.map((s) => s.text.replace(/^[{<](.+)[}>]$/, ':$1')).join('/')}`;
    return {
      method: step.method.toUpperCase().slice(0, 16),
      route,
      status: step.status ?? null,
      errorRate: step.errorRate ?? 0,
      count: step.count ?? journey.sessionCount,
      repeats: step.repeats ?? 0,
    };
  });

  return { ok: journeyIdOf(steps) === journey.id, steps };
}

trafficRouter.post('/traffic/:projectId/propose', requireRole('MEMBER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  // Called for its 404, not its value: a proposal against a project that does
  // not exist must not fall through to "no journeys matched".
  await loadProject(projectId);

  const parsed = proposeSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest('Invalid proposal request', parsed.error.flatten().fieldErrors);
  }
  const input = parsed.data;

  // The Generator writes against the Flow Map's real locators. Without one it
  // would invent selectors, and the worker throws — so say so here, where the
  // person who can fix it is still on the line.
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  if (!flowMap) {
    throw unprocessable(
      'This project has never been crawled, so the Generator has no locators to write against. ' +
        'Run the Explorer once, then propose these journeys again.',
    );
  }

  const suite = await loadSuite(projectId);

  const accepted: Array<{ journey: Journey; steps: ReturnType<typeof resanitise>['steps'] }> = [];
  const skipped: Array<{ what: string; why: string }> = [];
  const tampered: string[] = [];

  for (const raw of input.journeys) {
    const { ok, steps } = resanitise(raw);
    if (!ok) {
      tampered.push(raw.id);
      continue;
    }

    // Never trust a coverage verdict that arrived over the wire: the suite may
    // have gained the very test that covers this since /analyze ran.
    const coverage = crossReferenceSteps(steps, suite.tests);
    if (coverage.status === 'COVERED' && input.includeCovered !== true) {
      skipped.push({
        what: steps.map((s) => `${s.method} ${s.route}`).join(' → '),
        why:
          `Already covered by "${coverage.matchedTests[0]?.name ?? 'an existing test'}" — ` +
          'pass includeCovered to propose it anyway.',
      });
      continue;
    }

    accepted.push({
      steps,
      journey: {
        id: raw.id,
        name:
          raw.name ??
          steps
            .map((s) => s.route)
            .join(' → ')
            .slice(0, 200),
        feature: raw.feature ?? 'Traffic',
        steps,
        sessionCount: raw.sessionCount,
        sessionShare: raw.sessionShare,
        containingSessionCount: raw.containingSessionCount ?? raw.sessionCount,
        containingSessionShare: raw.containingSessionShare ?? raw.sessionShare,
        requestCount: raw.requestCount,
        medianDurationMs: raw.medianDurationMs ?? null,
        errorRate: raw.errorRate ?? 0,
        firstSeen: raw.firstSeen,
        lastSeen: raw.lastSeen,
        contentKind: raw.contentKind ?? 'unknown',
        identitySources: [],
        suggestedTestType: raw.contentKind === 'json' ? 'API' : 'E2E',
        suggestedPriority:
          raw.sessionShare >= 0.2
            ? 'CRITICAL_PATH'
            : raw.sessionShare >= 0.05
              ? 'IMPORTANT'
              : 'NICE_TO_HAVE',
        coverage,
      },
    });
  }

  if (tampered.length > 0) {
    throw badRequest(
      'Some journeys do not match their own id, which means their steps were changed after the ' +
        'analysis produced them. Re-run /analyze and propose the journeys it returns unmodified.',
      { journeyIds: tampered },
    );
  }

  if (accepted.length === 0) {
    res.status(200).json({
      testPlanId: null,
      jobId: null,
      accepted: 0,
      planItemIds: [],
      skipped,
      message: 'Every journey you selected is already covered by a test.',
    });
    return;
  }

  const source = input.source as TrafficFormat;
  const drafts = accepted.map(({ journey }) =>
    journeyToPlanItem(journey, {
      totalSessions: input.totalSessions,
      source,
      ...(input.testType ? { testType: input.testType } : {}),
    }),
  );

  const now = new Date();
  const plan = await prisma.testPlan.create({
    data: {
      orgId: actor.orgId,
      projectId,
      // Pinned to the Flow Map we just checked, so the worker generates against
      // the same crawl this endpoint validated against rather than re-picking.
      flowMapId: flowMap.id,
      summary:
        `${drafts.length} test${drafts.length === 1 ? '' : 's'} proposed from production ` +
        `traffic (${source}), ranked by how many of ${input.totalSessions} real sessions walk ` +
        'each journey. Traffic was redacted on ingest; no request content was stored.',
      skipped: skipped as unknown as object,
      items: {
        create: drafts.map((draft) => ({
          orgId: actor.orgId,
          title: draft.title,
          rationale: draft.rationale,
          feature: draft.feature,
          priority: draft.priority,
          testType: draft.testType,
          steps: draft.steps as unknown as object,
          assertions: draft.assertions as unknown as object,
          journeyId: draft.journeyId,
          // Selecting a journey IS the approval — the user picked it off a
          // ranked list. Leaving it PROPOSED would demand a second approval of
          // the same decision on a screen built for the Explorer's plans.
          state: 'APPROVED' as const,
          decidedBy: actor.userId,
          decidedAt: now,
        })),
      },
    },
    select: { id: true, items: { select: { id: true, title: true, journeyId: true } } },
  });

  /*
   * Generation needs a model. Missing one is a MISSING TOOL, not a failure —
   * the same call the coverage-gap route makes, and for the same reason: the
   * ranking, the redaction and the plan items are already done and already
   * worth having.
   *
   * Queueing anyway is worse than not queueing. The job dies in the worker with
   * "ANTHROPIC_API_KEY is not set", and the only thing the person ever saw was
   * a green "queued for generation" — a promise the deployment could not keep,
   * broken somewhere they are not looking. So: keep the plan, skip the queue,
   * and say so in the response.
   */
  const canGenerate = Boolean(env.ANTHROPIC_API_KEY);
  const jobId = canGenerate
    ? await enqueue(
        QUEUE_NAMES.generate,
        {
          orgId: actor.orgId,
          projectId,
          testPlanId: plan.id,
          planItemIds: plan.items.map((item) => item.id),
          requestedBy: actor.userId,
        },
        // Not idempotent: the processor inserts Test rows. One attempt only, so a
        // transient failure reports honestly instead of duplicating the suite.
        { attempts: 1 },
      )
    : null;

  await audit({
    actor,
    action: 'traffic.propose',
    targetType: 'TestPlan',
    targetId: plan.id,
    metadata: {
      source,
      accepted: plan.items.length,
      skippedAsCovered: skipped.length,
      totalSessions: input.totalSessions,
      queued: canGenerate,
      ...(canGenerate ? {} : { reason: 'no ANTHROPIC_API_KEY' }),
    },
  });

  res.status(202).json({
    jobId,
    testPlanId: plan.id,
    accepted: plan.items.length,
    planItemIds: plan.items.map((item) => item.id),
    items: plan.items,
    skipped,
    /*
     * The one cap that bites here, disclosed. Overclaiming coverage would hide
     * a journey nobody tests; UNDERclaiming — which is what a truncated suite
     * comparison produces — costs a duplicate proposal a human declines in one
     * click. The cheaper error, but still an error, so it is named rather than
     * absorbed.
     */
    suiteComparison: {
      compared: suite.tests.length,
      total: suite.total,
      truncated: suite.total > suite.tests.length,
      ...(suite.total > suite.tests.length
        ? {
            reason:
              `Coverage was re-checked against ${suite.tests.length} of ${suite.total} tests, so a ` +
              'journey proposed here may already be covered by one that was not compared.',
          }
        : {}),
    },
    generation: canGenerate
      ? { queued: true }
      : {
          queued: false,
          reason:
            'ANTHROPIC_API_KEY is not set on this deployment, so the Generator cannot be run. ' +
            'The plan items above are complete and were written from your traffic, not by a ' +
            'model — set the key and approve the plan to turn them into code.',
        },
  });
});

// ─── Live-traffic connectors ─────────────────────────────────────────────────

/**
 * The providers a live real-usage surface can be read from.
 *
 * Traffic used to be upload-only, which means the real-usage half of the
 * denominator went stale the moment it was pasted in: a route that stopped
 * being used last month still reads as hot, and a route shipped last week is
 * invisible until somebody remembers to re-export a log. A connector with a
 * window and a sync time is the difference between a measurement and a
 * souvenir.
 *
 * Four, and they are four because they are the four SHAPES of answer a
 * real-usage source gives, not four brands:
 *
 *   · DATADOG_RUM and SENTRY_PERFORMANCE answer with SESSIONED events — a
 *     session or trace id per request — so journeys can be derived.
 *   · CDN_LOG_DRAIN answers with access-log lines, the same shape the upload
 *     path already reads.
 *   · GA4 answers with PER-PAGE TOTALS and no ordering at all. It can enumerate
 *     routes and rank them; it cannot produce a journey, and pretending
 *     otherwise would mean inventing the sessions. See {@link ConnectorPayload}.
 */
export const TRAFFIC_CONNECTOR_PROVIDERS = [
  'GA4',
  'DATADOG_RUM',
  'SENTRY_PERFORMANCE',
  'CDN_LOG_DRAIN',
] as const;
export type TrafficConnectorProvider = (typeof TRAFFIC_CONNECTOR_PROVIDERS)[number];

/**
 * A connector's non-secret settings, by provider.
 *
 * Credentials are NOT here and never are: they live in `Integration.configEnc`,
 * sealed under the row's own AAD, on a row the customer owns. A connector whose
 * token lived in `process.env` would be one token for every tenant on the
 * deployment, which is not a connector, it is a shared account.
 */
export type TrafficConnectorConfig =
  | {
      provider: 'GA4';
      /** The numeric GA4 property, as `properties/123456` is built from. */
      propertyId: string;
      /** Restrict to one hostname when the property serves several. */
      hostFilter: string | null;
    }
  | {
      provider: 'DATADOG_RUM';
      /** `datadoghq.com`, `datadoghq.eu`, … — the API host is derived from it. */
      site: string;
      applicationId: string;
    }
  | {
      provider: 'SENTRY_PERFORMANCE';
      organisation: string;
      projectSlug: string;
    }
  | {
      provider: 'CDN_LOG_DRAIN';
      /** Where the drain publishes the window's lines. */
      endpointUrl: string;
    };

/**
 * Every discriminant {@link TrafficConnectorConfig} has, as a run-time value.
 *
 * BOTH HALVES OF THE GUARD, AND THE DEFECT THAT PROVES WHY. Eight `GateRule`
 * kinds shipped unsaveable by any customer for two slices because only one of
 * these two mechanisms existed: the compiler refuses to let this record drift
 * from the union, and the parity test in traffic.test.ts refuses to let the
 * zod schema below drift from this record. Each catches exactly what the other
 * cannot — a member added to the union with no schema branch compiles fine, and
 * a schema branch for a member the union does not have is unreachable.
 */
const TRAFFIC_CONNECTOR_CONFIG_PRESENT: Record<TrafficConnectorConfig['provider'], true> = {
  GA4: true,
  DATADOG_RUM: true,
  SENTRY_PERFORMANCE: true,
  CDN_LOG_DRAIN: true,
};

export const TRAFFIC_CONNECTOR_CONFIG_PROVIDERS = Object.keys(
  TRAFFIC_CONNECTOR_CONFIG_PRESENT,
) as ReadonlyArray<TrafficConnectorConfig['provider']>;

/** The settings every connector carries, whatever the provider. */
const connectorCommonSchema = z.object({
  /**
   * How far back a sync reads. Bounded on both ends: a one-hour window ranks
   * on noise, and a year of RUM is a bill rather than a measurement.
   */
  windowDays: z.coerce.number().int().min(1).max(90),
  /**
   * Which environment this traffic came from. Nullable and NOT defaulted to
   * production: a staging-only route entering a production denominator is
   * reported as an uncovered production gap, which is a fabricated defect.
   */
  environmentId: z.string().min(1).max(64).nullable().default(null),
});

const connectorConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('GA4'),
    propertyId: z.string().min(1).max(64),
    hostFilter: z.string().min(1).max(255).nullable().default(null),
  }),
  z.object({
    provider: z.literal('DATADOG_RUM'),
    site: z.string().min(1).max(64),
    applicationId: z.string().min(1).max(128),
  }),
  z.object({
    provider: z.literal('SENTRY_PERFORMANCE'),
    organisation: z.string().min(1).max(128),
    projectSlug: z.string().min(1).max(128),
  }),
  z.object({
    provider: z.literal('CDN_LOG_DRAIN'),
    endpointUrl: z.string().url().max(2048),
  }),
]);

/** The stored block, as it sits under `Integration.config.traffic`. */
const storedConnectorSchema = z.intersection(connectorConfigSchema, connectorCommonSchema);
type StoredConnector = z.infer<typeof storedConnectorSchema>;

/**
 * The run-time options of the zod union, for the parity test.
 *
 * Reads `.options` rather than being hand-listed, which is the point: a branch
 * added to the schema and not to the union shows up here and fails the test.
 */
export function connectorSchemaProviders(): string[] {
  return connectorConfigSchema.options.map((option) => option.shape.provider.value);
}

// ─── The injected transport ──────────────────────────────────────────────────

export interface TrafficTransportRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface TrafficTransportResponse {
  status: number;
  /** Decoded text. Every provider here answers JSON or log lines, never bytes. */
  body: string;
}

/**
 * The one capability a connector needs from the outside world.
 *
 * A NARROW INJECTED INTERFACE AND NOT A TOP-LEVEL IMPORT, for the reason 629
 * lines of crawler.ts demonstrate: a module that reaches for `fetch` at the top
 * is a module whose logic can only be tested by standing up a server. Every
 * reader below takes this and nothing else, so the parsing — which is where the
 * bugs are — is tested with a fake, and the adapter is four lines.
 */
export interface TrafficTransport {
  request(input: TrafficTransportRequest): Promise<TrafficTransportResponse>;
}

/**
 * The real adapter. Thin on purpose: it has no logic worth testing, so it has
 * none worth getting wrong.
 */
export function httpTransport(timeoutMs = 20_000): TrafficTransport {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

/**
 * What a connector came back with.
 *
 * TWO SHAPES, BECAUSE TWO SHAPES IS THE TRUTH. A sessioned source can be
 * sessionised into journeys; a totals source cannot, at all, ever, because the
 * ordering it would need was never in the answer. Collapsing them would mean
 * synthesising one session per page view and ranking the result — a journey
 * list assembled by us and presented as a journey list observed in production.
 */
export type ConnectorPayload =
  | {
      shape: 'SESSIONED';
      format: TrafficFormat;
      content: string | Record<string, unknown>;
    }
  | {
      shape: 'ROUTE_TOTALS';
      /** Per-route session counts, as the provider reported them. */
      rows: Array<{ route: string; sessions: number }>;
      /**
       * How many more rows the provider said it held beyond the ones returned,
       * when it said. Null means it did not say — which is not 0: a provider
       * that reports no total has not told us the answer was complete.
       */
      truncatedBy: number | null;
    };

/** Why a read produced nothing, kept apart from "it produced nothing". */
export const CONNECTOR_READ_OUTCOMES = [
  /** The provider answered and the answer was read. */
  'OK',
  /**
   * We could not ask. No credential on the row, no transport, a provider we
   * have no reader for. NOTHING is claimed about the application's traffic.
   */
  'UNAVAILABLE',
  /** We asked and the provider refused or errored. Also claims nothing. */
  'FAILED',
] as const;
export type ConnectorReadOutcome = (typeof CONNECTOR_READ_OUTCOMES)[number];

export interface ConnectorRead {
  outcome: ConnectorReadOutcome;
  /** Null unless `outcome` is OK. Never an empty payload standing in for one. */
  payload: ConnectorPayload | null;
  /**
   * The sampling rate the PROVIDER reported, 0–1.
   *
   * NULL IS NOT 1. "This source is unsampled" and "this source did not tell us
   * whether it samples" are different facts, and only the first of them lets
   * anything conclude that a route's absence from the answer means absence from
   * production. Everything downstream reads this field before drawing a
   * negative conclusion, and refuses to draw one when it is null or below 1.
   */
  samplingRate: number | null;
  /** The window asked for, from the connector's own `windowDays`. */
  window: { from: string; to: string };
  /** The sentence shown beside the state. Always written. */
  detail: string;
}

interface ReaderContext {
  transport: TrafficTransport;
  /** The opened credential, or null when the row carries none. */
  credential: string | null;
  window: { from: string; to: string };
}

type ConnectorReader = (config: StoredConnector, context: ReaderContext) => Promise<ConnectorRead>;

function unavailable(context: ReaderContext, detail: string): ConnectorRead {
  return {
    outcome: 'UNAVAILABLE',
    payload: null,
    samplingRate: null,
    window: context.window,
    detail,
  };
}

function failed(context: ReaderContext, detail: string): ConnectorRead {
  return { outcome: 'FAILED', payload: null, samplingRate: null, window: context.window, detail };
}

/** A number the provider gave us, or null. Never coerced to 1. */
function reportedRate(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw <= 0 || raw > 1) return null;
  return raw;
}

/**
 * GA4 — per-page session totals.
 *
 * `runReport` with a `pagePath` dimension and a `sessions` metric. GA4 also
 * reports `propertyQuota`/sampling metadata on sampled properties, and the
 * `samplingMetadatas` field is read for exactly that reason: a GA4 property on
 * the standard tier samples above 10M events and says so, and a route missing
 * from a sampled report is not a route nobody visits.
 */
const readGa4: ConnectorReader = async (config, context) => {
  if (config.provider !== 'GA4') return unavailable(context, 'wrong reader');
  if (!context.credential) {
    return unavailable(
      context,
      'No GA4 access token is stored on this connector, so the property was never asked. ' +
        'Nothing is claimed about this application’s traffic.',
    );
  }
  const response = await context.transport.request({
    url: `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(
      config.propertyId,
    )}:runReport`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${context.credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [
        { startDate: context.window.from.slice(0, 10), endDate: context.window.to.slice(0, 10) },
      ],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }],
      limit: MAX_SURFACE_WRITES,
      ...(config.hostFilter
        ? {
            dimensionFilter: {
              filter: {
                fieldName: 'hostName',
                stringFilter: { matchType: 'EXACT', value: config.hostFilter },
              },
            },
          }
        : {}),
    }),
  });
  if (response.status !== 200) {
    return failed(context, `GA4 answered ${response.status}. No traffic was read.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return failed(context, 'GA4 answered 200 with a body that is not JSON.');
  }
  const body = (parsed ?? {}) as {
    rows?: Array<{
      dimensionValues?: Array<{ value?: unknown }>;
      metricValues?: Array<{ value?: unknown }>;
    }>;
    rowCount?: unknown;
    samplingMetadatas?: Array<{ samplesReadCount?: unknown; samplingSpaceSize?: unknown }>;
  };

  const rows: Array<{ route: string; sessions: number }> = [];
  for (const row of body.rows ?? []) {
    const path = row.dimensionValues?.[0]?.value;
    const sessions = Number(row.metricValues?.[0]?.value);
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    rows.push({ route: path, sessions: Number.isFinite(sessions) ? sessions : 0 });
  }

  // GA4's own sampling arithmetic, read rather than assumed. Absent metadata
  // leaves the rate null — which blocks every absence conclusion downstream.
  const meta = body.samplingMetadatas?.[0];
  const read = Number(meta?.samplesReadCount);
  const space = Number(meta?.samplingSpaceSize);
  const rate =
    Number.isFinite(read) && Number.isFinite(space) && space > 0
      ? reportedRate(read / space)
      : null;

  /*
   * The `limit` sent with the request is a cap WE applied, so GA4's own
   * `rowCount` — the total before the limit — is read and the shortfall is
   * reported. Without it a property with 4,000 pages would answer with 500 and
   * the ingest would record 500 routes as though that were the property.
   */
  const total = Number(body.rowCount);
  const truncatedBy = Number.isFinite(total) && total > rows.length ? total - rows.length : null;

  return {
    outcome: 'OK',
    payload: { shape: 'ROUTE_TOTALS', rows, truncatedBy },
    samplingRate: rate,
    window: context.window,
    detail:
      `GA4 reported ${rows.length} page paths with session totals` +
      (truncatedBy === null
        ? ''
        : `, out of ${total} it holds — the request asked for ${MAX_SURFACE_WRITES}, so at least ` +
          `${truncatedBy} more real pages exist`) +
      '. GA4 carries no ordering, so this source enumerates and ranks routes and cannot produce ' +
      'journeys.',
  };
};

/**
 * Datadog RUM — sessioned view events.
 *
 * Returned as OTLP-shaped JSON rather than a bespoke format, so the existing
 * `analyzeTraffic` parser does the sessionising and there is exactly one
 * implementation of "what is a session" in the product.
 */
const readDatadogRum: ConnectorReader = async (config, context) => {
  if (config.provider !== 'DATADOG_RUM') return unavailable(context, 'wrong reader');
  if (!context.credential) {
    return unavailable(
      context,
      'No Datadog API key is stored on this connector, so RUM was never asked. Nothing is ' +
        'claimed about this application’s traffic.',
    );
  }
  const response = await context.transport.request({
    url: `https://api.${config.site}/api/v2/rum/events/search`,
    method: 'POST',
    headers: { 'dd-api-key': context.credential, 'content-type': 'application/json' },
    body: JSON.stringify({
      filter: {
        from: context.window.from,
        to: context.window.to,
        query: `@type:view @application.id:${config.applicationId}`,
      },
      page: { limit: 1000 },
    }),
  });
  if (response.status !== 200) {
    return failed(context, `Datadog answered ${response.status}. No traffic was read.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return failed(context, 'Datadog answered 200 with a body that is not JSON.');
  }
  const body = (parsed ?? {}) as {
    data?: Array<{ attributes?: Record<string, unknown> }>;
    meta?: { sampling_rate?: unknown; samplingRate?: unknown };
  };

  const spans = (body.data ?? []).flatMap((event) => {
    const attributes = event.attributes ?? {};
    const nested = (attributes.attributes ?? {}) as Record<string, unknown>;
    const view = (nested.view ?? {}) as Record<string, unknown>;
    const session = (nested.session ?? {}) as Record<string, unknown>;
    const url = typeof view.url_path === 'string' ? view.url_path : null;
    if (!url) return [];
    const at = typeof attributes.timestamp === 'number' ? attributes.timestamp : Date.now();
    return [
      {
        name: 'GET',
        startTimeUnixNano: String(at * 1_000_000),
        attributes: [
          { key: 'http.request.method', value: { stringValue: 'GET' } },
          { key: 'url.path', value: { stringValue: url } },
          ...(typeof session.id === 'string'
            ? [{ key: 'session.id', value: { stringValue: session.id } }]
            : []),
        ],
      },
    ];
  });

  return {
    outcome: 'OK',
    payload: {
      shape: 'SESSIONED',
      format: 'OTLP',
      content: { resourceSpans: [{ scopeSpans: [{ spans }] }] },
    },
    // Datadog reports the RUM session sample rate on the response meta. Absent
    // means we were not told, which stays null rather than becoming 1.
    samplingRate: reportedRate(body.meta?.sampling_rate ?? body.meta?.samplingRate),
    window: context.window,
    detail: `Datadog RUM returned ${spans.length} view events carrying session ids.`,
  };
};

/**
 * Sentry performance — transaction events.
 *
 * `transaction` is already a route template on a correctly instrumented SDK,
 * which is why `routeFromSource` exists in the upload path: a template the
 * source published beats a template we guessed from sibling values.
 */
const readSentryPerformance: ConnectorReader = async (config, context) => {
  if (config.provider !== 'SENTRY_PERFORMANCE') return unavailable(context, 'wrong reader');
  if (!context.credential) {
    return unavailable(
      context,
      'No Sentry auth token is stored on this connector, so the project was never asked. ' +
        'Nothing is claimed about this application’s traffic.',
    );
  }
  const query = new URLSearchParams({
    field: 'transaction',
    query: `event.type:transaction project:${config.projectSlug}`,
    start: context.window.from,
    end: context.window.to,
    per_page: '1000',
  });
  query.append('field', 'timestamp');
  query.append('field', 'trace');
  const response = await context.transport.request({
    url: `https://sentry.io/api/0/organizations/${encodeURIComponent(
      config.organisation,
    )}/events/?${query.toString()}`,
    method: 'GET',
    headers: { authorization: `Bearer ${context.credential}` },
  });
  if (response.status !== 200) {
    return failed(context, `Sentry answered ${response.status}. No traffic was read.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return failed(context, 'Sentry answered 200 with a body that is not JSON.');
  }
  const body = (parsed ?? {}) as {
    data?: Array<Record<string, unknown>>;
    meta?: { sample_rate?: unknown };
  };

  const spans = (body.data ?? []).flatMap((row) => {
    const transaction = row.transaction;
    if (typeof transaction !== 'string' || !transaction.startsWith('/')) return [];
    const stamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
    return [
      {
        name: 'GET',
        startTimeUnixNano: String((Number.isFinite(stamp) ? stamp : Date.now()) * 1_000_000),
        attributes: [
          { key: 'http.request.method', value: { stringValue: 'GET' } },
          // `http.route` and not `url.path`: Sentry's `transaction` IS the
          // template, so handing it over as a raw path would send it back
          // through the parameteriser that guesses templates from values.
          { key: 'http.route', value: { stringValue: transaction } },
          ...(typeof row.trace === 'string'
            ? [{ key: 'session.id', value: { stringValue: row.trace } }]
            : []),
        ],
      },
    ];
  });

  return {
    outcome: 'OK',
    payload: {
      shape: 'SESSIONED',
      format: 'OTLP',
      content: { resourceSpans: [{ scopeSpans: [{ spans }] }] },
    },
    /*
     * Sentry's traces sample rate is the single most important number here: a
     * project at `tracesSampleRate: 0.01` shows one transaction in a hundred,
     * and treating that as the whole picture would report 99% of a hot route's
     * traffic as absent. Read when reported; null when not.
     */
    samplingRate: reportedRate(body.meta?.sample_rate),
    window: context.window,
    detail: `Sentry returned ${spans.length} transactions, grouped by trace id.`,
  };
};

/**
 * A CDN or nginx log drain — the same access-log lines the upload path reads.
 *
 * A drain is UNSAMPLED by construction (it is the origin's own log), which is
 * the one source here that can license a conclusion about absence, so it
 * reports its rate as 1 rather than leaving it null. That claim is the
 * connector's, stated here, and not an inference anybody else has to make.
 */
const readCdnLogDrain: ConnectorReader = async (config, context) => {
  if (config.provider !== 'CDN_LOG_DRAIN') return unavailable(context, 'wrong reader');
  const headers: Record<string, string> = { accept: 'text/plain' };
  if (context.credential) headers.authorization = `Bearer ${context.credential}`;

  const response = await context.transport.request({
    url: config.endpointUrl,
    method: 'GET',
    headers,
  });
  if (response.status !== 200) {
    return failed(context, `The log drain answered ${response.status}. No traffic was read.`);
  }
  if (!response.body.trim()) {
    return failed(
      context,
      'The log drain answered 200 with an empty body. That is not the same as a window with no ' +
        'requests in it, so nothing was recorded.',
    );
  }
  return {
    outcome: 'OK',
    payload: { shape: 'SESSIONED', format: 'ACCESS_LOG', content: response.body },
    samplingRate: 1,
    window: context.window,
    detail: 'The origin log drain is the origin’s own record, so it is unsampled.',
  };
};

/**
 * One reader per provider.
 *
 * `Record<TrafficConnectorProvider, …>` and not a switch: a provider added to
 * the union with no reader fails to compile here, where the fix is obvious,
 * rather than falling into a `default:` branch that returns UNAVAILABLE and
 * reads to a customer as "this app has no traffic".
 */
const CONNECTOR_READERS: Record<TrafficConnectorProvider, ConnectorReader> = {
  GA4: readGa4,
  DATADOG_RUM: readDatadogRum,
  SENTRY_PERFORMANCE: readSentryPerformance,
  CDN_LOG_DRAIN: readCdnLogDrain,
};

/** Reads one connector. Exported so its logic is testable with a fake transport. */
export async function readConnector(
  config: StoredConnector,
  context: ReaderContext,
): Promise<ConnectorRead> {
  const reader = CONNECTOR_READERS[config.provider];
  try {
    return await reader(config, context);
  } catch (err) {
    // A thrown transport is a FAILED read and not a 500: the window, the
    // connector and the fact that nothing was learned are all still true and
    // all still worth storing.
    return failed(context, `The provider could not be reached: ${(err as Error).message}`);
  }
}

/**
 * Whether a source's silence may be read as absence.
 *
 * The whole asymmetry of this file in one function. A sampled source — or one
 * that would not say whether it samples — cannot support "this route is not
 * used" or "this test is waste", because the route may simply not be in the
 * sample. Presence conclusions are always sound; absence conclusions need this.
 */
export function mayConcludeAbsence(samplingRate: number | null): boolean {
  return samplingRate === 1;
}

// ─── The cross-reference: what the suite tests vs what users do ─────────────

/**
 * How hot a journey has to be to count as hot.
 *
 * A THRESHOLD, DISCLOSED, because a bucket boundary nobody states is a bucket
 * boundary nobody can argue with. 5% of sessions is the same line
 * `suggestedPriority` already draws between IMPORTANT and NICE_TO_HAVE, reused
 * rather than re-chosen so one journey cannot be hot on one screen and cold on
 * another.
 */
const HOT_SESSION_SHARE = 0.05;

/** The named lists are what gets forwarded; this bounds each one. */
const MAX_CROSS_REFERENCE_ROWS = 50;

/**
 * The three buckets, and why the third one is the dangerous one.
 *
 *   COVERED_AND_HOT     the suite and production agree. Reassurance.
 *   UNCOVERED_AND_HOT   observed journeys with no test. THE priority list, and
 *                       a sound conclusion from any source: the journey was
 *                       WALKED, so it exists, sampling or not.
 *   COVERED_AND_COLD    tests for journeys nobody walks. The suite's own waste
 *                       — and an ABSENCE conclusion, which a sampled source
 *                       cannot support. A route can be missing from a 1%-sampled
 *                       RUM feed and still be walked by thousands of people, so
 *                       telling a customer to delete that test on this evidence
 *                       would be a wrong answer in the expensive direction.
 */
export const CROSS_REFERENCE_BUCKETS = [
  'COVERED_AND_HOT',
  'UNCOVERED_AND_HOT',
  'COVERED_AND_COLD',
] as const;
export type CrossReferenceBucket = (typeof CROSS_REFERENCE_BUCKETS)[number];

const CROSS_REFERENCE_BUCKET_PRESENT: Record<CrossReferenceBucket, string> = {
  COVERED_AND_HOT: 'journeys most users walk that the suite already covers',
  UNCOVERED_AND_HOT: 'journeys most users walk that no test covers',
  COVERED_AND_COLD: 'journeys the suite covers that almost nobody walks',
};

export const CROSS_REFERENCE_BUCKET_LABELS: Readonly<Record<CrossReferenceBucket, string>> =
  CROSS_REFERENCE_BUCKET_PRESENT;

/**
 * Buckets stored journeys against the suite.
 *
 * Reads `ObservedJourney`, not a fresh upload: the whole reason the persistence
 * above exists is that this question has to be answerable on a Monday morning
 * with nobody re-pasting a log file.
 */
trafficRouter.get(
  '/traffic/:projectId/cross-reference',
  requireRole('VIEWER'),
  async (req, res) => {
    const projectId = String(req.params.projectId);
    await loadProject(projectId);

    const latestIngest = await prisma.trafficIngest.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        format: true,
        createdAt: true,
        observedFrom: true,
        observedTo: true,
        sessions: true,
        capsThatBit: true,
        integrationId: true,
      },
    });

    if (!latestIngest) {
      /*
       * NEVER_INGESTED and not an empty cross-reference. "No traffic has ever
       * been uploaded or synced" and "your users walk nothing" are opposite
       * facts, and an empty bucket list would read as the second one.
       */
      res.json({
        state: 'NEVER_INGESTED',
        reason:
          'No traffic has ever been uploaded or synced for this project, so there is nothing to ' +
          'cross-reference. This is not a statement that your users walk nothing.',
        buckets: null,
        window: null,
        hotThreshold: HOT_SESSION_SHARE,
      });
      return;
    }

    /*
     * The read is bounded, so the bound is MEASURED against the table rather
     * than hoped about. Without the count, a project with 400 observed journeys
     * would have its buckets computed from the 150 hottest and report three
     * counts that are all too low — an undisclosed cap on the numbers the
     * priority list is built from.
     *
     * The journeys are read hottest-first, so what a bite drops is the tail:
     * `UNCOVERED_AND_HOT` is unaffected and the bound is named anyway.
     */
    const journeyReadLimit = MAX_CROSS_REFERENCE_ROWS * CROSS_REFERENCE_BUCKETS.length;
    const [journeys, journeysStored] = await Promise.all([
      prisma.observedJourney.findMany({
        where: { projectId },
        orderBy: { sessionShare: 'desc' },
        take: journeyReadLimit,
        select: {
          journeyKey: true,
          name: true,
          feature: true,
          sessionCount: true,
          sessionShare: true,
          errorRate: true,
          coverageStatus: true,
          matchedRatio: true,
          missingSteps: true,
          ingestCount: true,
          firstObservedAt: true,
          lastObservedAt: true,
        },
      }),
      prisma.observedJourney.count({ where: { projectId } }),
    ]);

    type Row = (typeof journeys)[number];
    const shape = (row: Row) => ({
      journeyKey: row.journeyKey,
      name: row.name,
      feature: row.feature,
      sessionCount: row.sessionCount,
      sessionShare: row.sessionShare,
      errorRate: row.errorRate,
      coverageStatus: row.coverageStatus,
      matchedRatio: row.matchedRatio,
      missingSteps: row.missingSteps,
      ingestCount: row.ingestCount,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
    });

    const hot = (row: Row) => row.sessionShare >= HOT_SESSION_SHARE;
    const covered = (row: Row) => row.coverageStatus === 'COVERED';

    const coveredHot = journeys.filter((row) => covered(row) && hot(row));
    const uncoveredHot = journeys.filter((row) => !covered(row) && hot(row));
    const coveredCold = journeys.filter((row) => covered(row) && !hot(row));

    /*
     * The suite-comparison cap travels with the ingest for exactly this read: a
     * verdict computed against 500 of 900 tests is a verdict about a subset, and
     * the screen that prints "no test covers this" has to know that.
     */
    const caps = Array.isArray(latestIngest.capsThatBit)
      ? (latestIngest.capsThatBit as unknown as TrafficCapBite[])
      : [];
    const suiteCap = caps.find((cap) => cap.cap === 'SUITE_COMPARISON') ?? null;

    /*
     * This endpoint's OWN cap, added to the ingest's. A reader must not have to
     * know that the API paginates to know that a count is a floor.
     */
    const readCaps: TrafficCapBite[] =
      journeysStored > journeys.length
        ? [
            {
              cap: 'JOURNEY_PERSISTENCE',
              limit: journeyReadLimit,
              bites: 1,
              discarded: journeysStored - journeys.length,
              discardedIsExact: true,
              reason:
                `This project has ${journeysStored} stored journeys and the ${journeyReadLimit} ` +
                'most-walked were read, so every count below is a floor. The journeys are read ' +
                'hottest-first, so what is missing is the tail.',
            },
          ]
        : [];

    /*
     * Sampling is read from the connector that produced the newest ingest, and
     * `null` — "nobody told us" — is treated exactly like "sampled". Both block
     * the absence conclusion; only a source that affirmatively says it is
     * unsampled licenses one.
     */
    const samplingRate = latestIngest.integrationId
      ? await samplingRateOf(latestIngest.integrationId)
      : null;
    const absenceAllowed = mayConcludeAbsence(samplingRate);

    res.json({
      state: 'MEASURED',
      window: {
        from: latestIngest.observedFrom,
        to: latestIngest.observedTo,
        ingestedAt: latestIngest.createdAt,
        format: latestIngest.format,
        sessions: latestIngest.sessions,
      },
      hotThreshold: HOT_SESSION_SHARE,
      samplingRate,
      buckets: {
        COVERED_AND_HOT: {
          label: CROSS_REFERENCE_BUCKET_LABELS.COVERED_AND_HOT,
          count: coveredHot.length,
          journeys: coveredHot.slice(0, MAX_CROSS_REFERENCE_ROWS).map(shape),
          truncated: coveredHot.length > MAX_CROSS_REFERENCE_ROWS,
          conclusive: true,
        },
        UNCOVERED_AND_HOT: {
          label: CROSS_REFERENCE_BUCKET_LABELS.UNCOVERED_AND_HOT,
          count: uncoveredHot.length,
          journeys: uncoveredHot.slice(0, MAX_CROSS_REFERENCE_ROWS).map(shape),
          truncated: uncoveredHot.length > MAX_CROSS_REFERENCE_ROWS,
          /*
           * Sound whatever the sampling: these journeys were OBSERVED. A sampled
           * source under-reports, which can only make this list shorter than the
           * truth — so it is a floor, and a floor on a gap list is safe.
           */
          conclusive: true,
          ...(suiteCap
            ? {
                caveat:
                  `${suiteCap.reason} This list is therefore an upper bound: some of these ` +
                  'journeys may be covered by a test that was not compared.',
              }
            : {}),
        },
        COVERED_AND_COLD: {
          label: CROSS_REFERENCE_BUCKET_LABELS.COVERED_AND_COLD,
          count: coveredCold.length,
          journeys: absenceAllowed ? coveredCold.slice(0, MAX_CROSS_REFERENCE_ROWS).map(shape) : [],
          truncated: absenceAllowed && coveredCold.length > MAX_CROSS_REFERENCE_ROWS,
          /*
           * The refusal. This bucket asserts that almost nobody walks a journey,
           * which is an absence conclusion, so it is withheld entirely rather
           * than shown with a footnote nobody reads.
           */
          conclusive: absenceAllowed,
          ...(absenceAllowed
            ? {}
            : {
                withheld:
                  samplingRate === null
                    ? 'The newest source did not report a sampling rate, so a journey being rare in ' +
                      'it is not evidence that it is rare in production. Naming these tests as ' +
                      'waste would be a conclusion drawn from a source that cannot support it.'
                    : `The newest source reported a sampling rate of ${samplingRate}, so a journey ` +
                      'being rare in it is not evidence that it is rare in production.',
              }),
        },
      },
      journeysStored,
      journeysRead: journeys.length,
      /** The ingest's caps and this read's own, in one list. */
      capsThatBit: [...caps, ...readCaps],
    });
  },
);

// ─── Connectors: keeping the real-usage surface from going stale ─────────────

/**
 * What a connector's sync history says about it.
 *
 * `NEVER_SYNCED` IS THE WHOLE REASON THIS ENUM EXISTS. A connector that has
 * never run and an application whose users walk nothing produce the same empty
 * journey list, and exactly one of those is bad news for the customer. Reading
 * the first as the second is the defect: the screen would say "0 journeys
 * observed" about an app with millions of sessions and a credential nobody
 * finished pasting in.
 */
export const CONNECTOR_SYNC_STATES = [
  /** Configured and never once succeeded. Nothing is known about the traffic. */
  'NEVER_SYNCED',
  /** It has succeeded, and `lastSucceededAt` says when. */
  'SYNCED',
  /** It succeeded before and the most recent attempt failed. Both facts kept. */
  'STALE_AFTER_FAILURE',
] as const;
export type ConnectorSyncState = (typeof CONNECTOR_SYNC_STATES)[number];

const CONNECTOR_SYNC_STATE_PRESENT: Record<ConnectorSyncState, string> = {
  NEVER_SYNCED:
    'This connector has never completed a sync, so nothing is known about this application’s ' +
    'real traffic. That is not the same as an application with no traffic.',
  SYNCED: 'Last sync succeeded.',
  STALE_AFTER_FAILURE:
    'An earlier sync succeeded and the most recent attempt failed, so the numbers below describe ' +
    'the older window.',
};

export const CONNECTOR_SYNC_STATE_LABELS: Readonly<Record<ConnectorSyncState, string>> =
  CONNECTOR_SYNC_STATE_PRESENT;

/**
 * The stored traffic block on an `Integration`, or null when the row is not a
 * traffic connector.
 *
 * Read defensively, like every other `config` reader in this codebase: the
 * column is JSON and a row written by an older shape must degrade to "not a
 * traffic connector" rather than throwing inside a list endpoint.
 */
function trafficBlockOf(config: unknown): StoredConnector | null {
  if (!config || typeof config !== 'object') return null;
  const block = (config as { traffic?: unknown }).traffic;
  const parsed = storedConnectorSchema.safeParse(block);
  return parsed.success ? parsed.data : null;
}

/**
 * The provider a row declares.
 *
 * Read from `config.traffic.provider` and not from `Integration.kind`, because
 * `IntegrationKind` has no member for any of these four yet — see
 * needsFromOtherFiles. When it does, `kind` becomes the authority and this
 * function prefers it; until then the config block is the only place the fact
 * can live, and inventing a parallel table to hold it would be worse.
 */
function providerOf(row: { kind: string; config: unknown }): TrafficConnectorProvider | null {
  if ((TRAFFIC_CONNECTOR_PROVIDERS as readonly string[]).includes(row.kind)) {
    return row.kind as TrafficConnectorProvider;
  }
  return trafficBlockOf(row.config)?.provider ?? null;
}

/**
 * The sampling rate the newest successful sync on this connector reported.
 *
 * Stored on the connector row rather than on the ingest because `TrafficIngest`
 * has no column for it yet (see needsFromOtherFiles). Null is returned for
 * every path that does not KNOW: no row, no traffic block, no recorded sync. It
 * is never 1 by default — defaulting it to 1 would quietly license every
 * absence conclusion in the cross-reference.
 */
async function samplingRateOf(integrationId: string): Promise<number | null> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { kind: true, config: true },
  });
  if (!row) return null;
  const sync = lastSyncOf(row.config);
  return typeof sync?.samplingRate === 'number' ? sync.samplingRate : null;
}

/** The sync bookkeeping kept beside the connector's settings. Non-secret. */
const lastSyncSchema = z.object({
  atIso: z.string(),
  ingestId: z.string(),
  samplingRate: z.number().nullable(),
  journeysStored: z.number().int(),
  sessions: z.number().int(),
  windowFrom: z.string().nullable(),
  windowTo: z.string().nullable(),
});
const lastAttemptSchema = z.object({
  atIso: z.string(),
  outcome: z.enum(CONNECTOR_READ_OUTCOMES),
  detail: z.string(),
});

function lastSyncOf(config: unknown): z.infer<typeof lastSyncSchema> | null {
  if (!config || typeof config !== 'object') return null;
  const parsed = lastSyncSchema.safeParse(
    (config as { trafficLastSync?: unknown }).trafficLastSync,
  );
  return parsed.success ? parsed.data : null;
}

function lastAttemptOf(config: unknown): z.infer<typeof lastAttemptSchema> | null {
  if (!config || typeof config !== 'object') return null;
  const parsed = lastAttemptSchema.safeParse(
    (config as { trafficLastAttempt?: unknown }).trafficLastAttempt,
  );
  return parsed.success ? parsed.data : null;
}

function syncStateOf(config: unknown): ConnectorSyncState {
  const sync = lastSyncOf(config);
  if (!sync) return 'NEVER_SYNCED';
  const attempt = lastAttemptOf(config);
  if (attempt && attempt.outcome !== 'OK' && attempt.atIso > sync.atIso) {
    return 'STALE_AFTER_FAILURE';
  }
  return 'SYNCED';
}

/** Lists the project's traffic connectors and what each one's history says. */
trafficRouter.get('/traffic/:projectId/connectors', requireRole('VIEWER'), async (req, res) => {
  const actor = actorOf(req);
  const projectId = String(req.params.projectId);
  await loadProject(projectId);

  const rows = await prisma.integration.findMany({
    where: { orgId: actor.orgId, OR: [{ projectId }, { projectId: null }] },
    select: { id: true, kind: true, name: true, enabled: true, config: true, configEnc: true },
    orderBy: { createdAt: 'asc' },
  });

  const connectors = rows.flatMap((row) => {
    const provider = providerOf(row);
    const block = trafficBlockOf(row.config);
    if (!provider || !block) return [];
    const state = syncStateOf(row.config);
    const sync = lastSyncOf(row.config);
    return [
      {
        integrationId: row.id,
        name: row.name,
        provider,
        enabled: row.enabled,
        windowDays: block.windowDays,
        environmentId: block.environmentId,
        /** Whether a credential is present. Never the credential. */
        hasCredential: row.configEnc !== null,
        syncState: state,
        syncStateDetail: CONNECTOR_SYNC_STATE_LABELS[state],
        lastSucceededAt: sync?.atIso ?? null,
        /**
         * Null when nothing ever succeeded. Not 0 — a connector that has never
         * run has not observed zero sessions, it has observed nothing.
         */
        lastWindow: sync ? { from: sync.windowFrom, to: sync.windowTo } : null,
        lastSessions: sync?.sessions ?? null,
        lastJourneysStored: sync?.journeysStored ?? null,
        samplingRate: sync?.samplingRate ?? null,
        /**
         * Whether this source can support a conclusion that a route is NOT
         * used. Only an affirmatively unsampled source can.
         */
        mayConcludeAbsence: mayConcludeAbsence(sync?.samplingRate ?? null),
        lastAttempt: lastAttemptOf(row.config),
      },
    ];
  });

  res.json({
    connectors,
    /** Stated even when empty, so "none configured" is a sentence and not a blank. */
    note:
      connectors.length === 0
        ? 'No live-traffic connector is configured for this project, so the real-usage surface is ' +
          'only as fresh as the last manual upload.'
        : 'Each connector reports when it last SUCCEEDED. A connector reading NEVER_SYNCED has ' +
          'told us nothing about this application’s traffic — which is not the same as telling us ' +
          'the application has none.',
    providers: TRAFFIC_CONNECTOR_PROVIDERS,
  });
});

/**
 * Pulls one connector's window and runs it through the same ingest the upload
 * path uses.
 *
 * Two outcomes are written whatever happens: the attempt is always recorded on
 * the row, and a successful read also records the sync. A failure must not
 * leave a connector looking as though it had never been configured, and must
 * not leave a previous success looking current either — hence
 * `STALE_AFTER_FAILURE`.
 */
trafficRouter.post(
  '/traffic/:projectId/connectors/:integrationId/sync',
  requireRole('MEMBER'),
  async (req, res) => {
    const actor = actorOf(req);
    const projectId = String(req.params.projectId);
    const integrationId = String(req.params.integrationId);
    await loadProject(projectId);

    const row = await prisma.integration.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        orgId: true,
        kind: true,
        name: true,
        enabled: true,
        config: true,
        configEnc: true,
      },
    });
    if (!row || row.orgId !== actor.orgId) throw notFound('Integration');

    const block = trafficBlockOf(row.config);
    const provider = providerOf(row);
    if (!block || !provider) {
      throw unprocessable(
        'This integration is not a traffic connector — it carries no `traffic` settings block. ' +
          `Configure one of: ${TRAFFIC_CONNECTOR_PROVIDERS.join(', ')}.`,
      );
    }
    if (!row.enabled) {
      throw unprocessable('This connector is disabled. Enable it before syncing.');
    }

    const to = new Date();
    const from = new Date(to.getTime() - block.windowDays * 24 * 60 * 60_000);
    const window = { from: from.toISOString(), to: to.toISOString() };

    /*
     * The credential is opened here and nowhere else, is handed only to the
     * reader, and is never returned, logged or written to audit metadata. A row
     * with no ciphertext yields null, which the readers report as UNAVAILABLE —
     * "we could not ask" — and never as "this app has no traffic".
     */
    let credential: string | null = null;
    if (row.configEnc) {
      const keyVersion = Number((row.config as { keyVersion?: unknown } | null)?.keyVersion ?? 1);
      try {
        credential = openToken(row.configEnc, keyVersion, row.orgId, row.id);
      } catch {
        /*
         * A ciphertext that will not open — a rotated master key, a row copied
         * between orgs — leaves the credential null, which the readers report
         * as UNAVAILABLE. The error itself is not surfaced to the caller and
         * not written to the row: it is about our vault, not their traffic.
         */
        logger.warn({ integrationId: row.id }, 'traffic connector credential would not open');
        credential = null;
      }
    }

    const read = await readConnector(block, {
      transport: httpTransport(),
      credential,
      window,
    });

    const attempt = {
      atIso: new Date().toISOString(),
      outcome: read.outcome,
      detail: read.detail,
    };

    if (read.outcome !== 'OK' || !read.payload) {
      await recordConnectorAttempt(row.id, row.config, { attempt });
      await audit({
        actor,
        action: 'traffic.connector.sync',
        targetType: 'Integration',
        targetId: row.id,
        metadata: { provider, outcome: read.outcome, windowDays: block.windowDays },
      });
      /*
       * 200 and not 502. The request succeeded; what failed is the provider,
       * and the outcome, the reason and the unchanged sync state are the
       * answer. A 5xx here would make a connector that has never been given a
       * credential indistinguishable from a broken API.
       */
      res.json({
        synced: false,
        outcome: read.outcome,
        detail: read.detail,
        window,
        syncState: syncStateOf(row.config),
        ingestId: null,
        samplingRate: null,
        mayConcludeAbsence: false,
      });
      return;
    }

    const suite = await loadSuite(projectId);
    let ingestId: string;
    let journeysStored = 0;
    let sessions = 0;
    let surface: { created: number; updated: number; reinstated: number; dropped: number };
    let caps: TrafficCapBite[] = [];

    if (read.payload.shape === 'ROUTE_TOTALS') {
      /*
       * A totals source has routes and no ordering, so it enumerates and ranks
       * surface and produces NO journeys. Storing a zero journey count beside
       * an explicit reason is the honest shape; synthesising one session per
       * page view would produce a journey list we assembled and presented as
       * one production walked.
       */
      /*
       * `surfaceFromRouteTotals` MERGES rows that canonicalise to the same
       * route — `/users/1` and `/users/2` are one `/users/:param` — so the
       * shortfall between the provider's row count and the write count is
       * mostly deduplication and NOT a cap. Measuring the cap against the
       * provider's rows would report a cap bite on every sync that saw two ids
       * under one template, and a cap disclosed when it did not bite teaches a
       * reader to ignore the disclosure.
       */
      const candidates = surfaceFromRouteTotals(read.payload.rows, provider);
      const writes = candidates.slice(0, MAX_SURFACE_WRITES);
      const dropped = candidates.length - writes.length;
      if (dropped > 0) {
        caps = [
          {
            cap: 'SURFACE_PERSISTENCE',
            limit: MAX_SURFACE_WRITES,
            bites: 1,
            discarded: dropped,
            discardedIsExact: true,
            reason:
              `${provider} reported ${candidates.length} distinct routes and the ` +
              `${MAX_SURFACE_WRITES} most-visited were merged. At least ${dropped} more real ` +
              'routes exist and are not yet counted.',
          },
        ];
      }
      /*
       * The provider's OWN truncation is a separate cap with a separate cause:
       * the request limit we sent. Reported as a floor, because `rowCount` is
       * what the provider says it holds and the window may hold more.
       */
      if (read.payload.truncatedBy !== null) {
        caps = [
          ...caps,
          {
            cap: 'PROVIDER_ROW_LIMIT',
            limit: MAX_SURFACE_WRITES,
            bites: 1,
            discarded: read.payload.truncatedBy,
            /*
             * FALSE, and the comment above already said so while the field
             * said the opposite: this number is `rowCount` minus what came
             * back, which is what the provider says it holds FOR THIS WINDOW —
             * a floor on the real shortfall, not a measurement of it. "Exact"
             * beside a reason that reads "at least N more" is a disclosed cap
             * contradicting itself, and a reader has to be able to trust which
             * of the two fields to believe.
             */
            discardedIsExact: false,
            reason:
              `The request to ${provider} asked for ${MAX_SURFACE_WRITES} pages and the property ` +
              `holds at least ${read.payload.truncatedBy} more. Those pages were never read, so ` +
              'they are not in this project’s inventory.',
          },
        ];
      }
      const ingest = await prisma.trafficIngest.create({
        data: {
          orgId: actor.orgId,
          projectId,
          environmentId: block.environmentId,
          // Not one of the three upload formats: this source is a totals API,
          // and labelling it HAR or ACCESS_LOG would misdescribe it to every
          // reader of the row.
          format: `${provider}_ROUTE_TOTALS`,
          integrationId: row.id,
          requestedBy: actor.userId,
          observedFrom: from,
          observedTo: to,
          entriesParsed: read.payload.rows.length,
          entriesSkipped: 0,
          // Honest zero: a totals source cannot report sessions as sequences,
          // so no session was enumerated. The `detail` beside it says why.
          sessions: 0,
          journeysStored: 0,
          journeysDroppedByCap: 0,
          capsThatBit: bitingCaps(caps).map((cap) => ({ ...cap })),
        },
        select: { id: true },
      });
      ingestId = ingest.id;
      surface = {
        ...(await mergeObservedSurface({
          orgId: actor.orgId,
          projectId,
          environmentId: block.environmentId,
          writes,
        })),
        dropped,
      };
    } else {
      let analysis: TrafficAnalysis;
      try {
        analysis = analyzeTraffic(read.payload.content, {
          format: read.payload.format,
          maxEntries: API_MAX_ENTRIES,
          maxJourneys: 25,
          existingTests: suite.tests,
        });
      } catch (err) {
        if (!(err instanceof TrafficFormatError)) throw err;
        await recordConnectorAttempt(row.id, row.config, {
          attempt: { ...attempt, outcome: 'FAILED', detail: err.message },
        });
        res.json({
          synced: false,
          outcome: 'FAILED',
          detail: `The provider answered in a shape the parser could not read: ${err.message}`,
          window,
          syncState: syncStateOf(row.config),
          ingestId: null,
          samplingRate: read.samplingRate,
          mayConcludeAbsence: false,
        });
        return;
      }

      caps = analysisCaps({
        analysis,
        maxJourneys: 25,
        suiteCompared: suite.tests.length,
        suiteTotal: suite.total,
      });
      const persisted = await persistIngest({
        orgId: actor.orgId,
        projectId,
        environmentId: block.environmentId,
        format: read.payload.format,
        integrationId: row.id,
        requestedBy: actor.userId,
        analysis,
        caps,
      });
      ingestId = persisted.ingestId;
      journeysStored = persisted.journeysStored;
      sessions = analysis.totals.sessions;
      surface = persisted.surface;
    }

    await recordConnectorAttempt(row.id, row.config, {
      attempt,
      sync: {
        atIso: attempt.atIso,
        ingestId,
        samplingRate: read.samplingRate,
        journeysStored,
        sessions,
        windowFrom: window.from,
        windowTo: window.to,
      },
    });

    await audit({
      actor,
      action: 'traffic.connector.sync',
      targetType: 'Integration',
      targetId: row.id,
      metadata: {
        provider,
        outcome: 'OK',
        ingestId,
        windowDays: block.windowDays,
        journeysStored,
        surfaceMerged: surface.created + surface.updated,
        surfaceReinstated: surface.reinstated,
        // Recorded on a durable row so the sampling rate of a measurement
        // survives even though TrafficIngest has no column for it yet.
        samplingRate: read.samplingRate,
        capsThatBit: bitingCaps(caps).map((cap) => cap.cap),
      },
    });

    res.json({
      synced: true,
      outcome: 'OK',
      detail: read.detail,
      window,
      syncState: 'SYNCED' satisfies ConnectorSyncState,
      ingestId,
      journeysStored,
      sessions,
      surfaceCreated: surface.created,
      surfaceUpdated: surface.updated,
      /** Retired registry rows this sync brought back. See the upload path. */
      surfaceReinstated: surface.reinstated,
      surfaceNotStored: surface.dropped,
      samplingRate: read.samplingRate,
      mayConcludeAbsence: mayConcludeAbsence(read.samplingRate),
      capsThatBit: bitingCaps(caps),
    });
  },
);

/**
 * Records the attempt, and the sync when there was one, on the connector row.
 *
 * Read-modify-write over the existing `config` blob and NOT a replacement: the
 * provider settings, the key version and anything another feature keeps there
 * all live in the same column, and a wholesale overwrite would delete the
 * credential's key version and make the next sync unable to open its own token.
 *
 * The attempt is recorded even when nothing was learned. "We tried at 09:04 and
 * the provider returned 403" is the fact that distinguishes a connector nobody
 * finished configuring from one that is broken, and dropping it would leave
 * both reading as NEVER_SYNCED forever.
 */
async function recordConnectorAttempt(
  integrationId: string,
  currentConfig: unknown,
  update: {
    attempt: z.infer<typeof lastAttemptSchema>;
    sync?: z.infer<typeof lastSyncSchema>;
  },
): Promise<void> {
  const base =
    currentConfig && typeof currentConfig === 'object'
      ? (currentConfig as Record<string, unknown>)
      : {};
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      config: {
        ...base,
        trafficLastAttempt: update.attempt,
        ...(update.sync ? { trafficLastSync: update.sync } : {}),
      },
    },
  });
}
