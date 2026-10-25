export * from './llm.js';
export * from './crawler.js';
export * from './explorer.js';
export * from './ecosystem-prompts.js';
export * from './generator.js';
export * from './spec-strategies.js';
export * from './triage.js';
export * from './healer.js';
export * from './heal-apply.js';
export * from './inline-edit.js';
export * from './chat.js';
export * from './importer.js';
export * from './traffic.js';
/*
 * coverage.js is the only model-free way to turn a crawl into plan items, so it
 * is the fallback every "the Generator needs a key" path leans on. It was
 * missing from this barrel, which is why routes/coverage.ts reaches into
 * ../../../../packages/agent/src/coverage.js by relative path with a comment
 * asking for exactly this line. No export name here collides with the modules
 * above.
 */
export * from './coverage.js';
export * from './surface-inventory.js';
export * from './surface-coverage.js';

/*
 * The heal lane's two newest modules. Both were reached by RELATIVE PATH from
 * another workspace — `../../../../packages/agent/src/deflake.js` in
 * apps/worker/src/processors/flake.ts and the same shape for obsolete.js there
 * and in apps/api/src/routes/agent.ts — because this file was owned by another
 * change when they landed. A relative import across a workspace boundary
 * compiles and then bypasses the package's own entry point, which is the thing
 * the comment in repro.ts establishes as the one to avoid.
 *
 * `obsolete.js` imports from coverage.js and suite-health.js, both already in
 * this graph, so neither line adds a cycle. No name collides: the two export
 * the `Deflake`, `Obsolete`, `Drift` and `Surface` shapes plus
 * `proposeDeflake`, `auditTestsAgainstCrawl` and `driftCheck`.
 */
export * from './deflake.js';
export * from './obsolete.js';

/*
 * The generation gates. Each of these was flagged `package-exports` by
 * check:wiring the moment it landed — built, tested, and reachable from
 * nothing but its own test file, which is this codebase's signature defect.
 *
 * `admission.js` owns the gate vocabulary (GateId/GateStatus/GateOutcome);
 * `toolchain.js` imports those types type-only and deliberately does not
 * re-export them, so there is exactly one of each name in this barrel.
 */
export * from './admission.js';
export * from './toolchain.js';
export * from './mutation-gate.js';
export * from './boundaries.js';

/*
 * The enumerate slice. Five modules under `crawl/`, re-exported through their
 * own directory barrel so the name collisions between them are resolved in ONE
 * place with the reasoning beside them — see packages/agent/src/crawl/index.ts.
 *
 * `crawler.ts` above imports all five and composes them, so they are reachable
 * by a real call path and not only by this line; this line is what makes the
 * SHAPES public, which apps/worker needs in order to persist the frontier
 * snapshot, the known-unknown lower bound and the observation report.
 *
 * Name check done against this barrel's existing graph: `crawler.ts` exports
 * `normaliseRoute`, `semanticFor`, `crawl`, `crawlApp`, `runCrawl`,
 * `deriveJourneys`, `groupIntoFeatures` and the adapter types, and none of the
 * five modules exports any of those.
 */
export * from './crawl/index.js';

/*
 * The non-crawl half of enumeration. Five modules, each of which `check:wiring`
 * flagged under `package-exports` the moment it landed — built, tested, and
 * reachable from nothing but its own test file.
 *
 * Two are reached by a real call path as well as by these lines: `importer.ts`
 * (already above) imports `api-surface.ts`, and `reconcile.ts` imports
 * `surface-catalog.ts`'s neighbours. The rest are reached only from here, which
 * is what makes their shapes public API — apps/api needs `ingestApiDocument`
 * for POST /api-surface (it answers 501 naming that export until this line
 * exists), and the enumerate orchestrator needs `extractRouteManifest`,
 * `routeManifestSurfaceItems`, `matchExpectedSurface` and `reconcileSurface`.
 *
 * Name collisions: the five modules' authors each diffed their exported names
 * against this barrel's existing graph and against each other, and I re-ran the
 * check across all of packages/agent/src, packages/agent/src/crawl and
 * packages/shared/src after they landed. `route-manifest.ts` renamed its
 * `RouteTemplate` to `DeclaredRoute` because `crawl/frontier.ts` owns that name;
 * nothing else overlaps, and `tsc -p packages/agent/tsconfig.json` reports no
 * TS2308 on this file.
 *
 * Order is deliberate: `api-surface.ts` first because `importer.ts` above
 * already pulls it into the graph, then the three modules that import
 * `coverage.js` and `surface-inventory.js` (both above), so no line here
 * introduces a cycle this barrel did not already have.
 */
export * from './api-surface.js';
export * from './route-manifest.js';
export * from './surface-catalog.js';
export * from './reconcile.js';

/*
 * Crawl-to-crawl drift. The schema and the cockpit both CLAIMED versions were
 * diffed and no diff code existed anywhere in the repo, so four new routes with
 * zero tests produced no event at all. `flow-diff.ts` is that computation, and
 * `apps/worker/src/processors/schedule.ts` reaches it by relative path with a
 * comment asking for exactly this line.
 *
 * ── ONE NAME DOES COLLIDE, AND IT IS NOT RE-EXPORTED ───────────────────────
 *
 * NOT a star export, because `flow-diff.ts` exports `controlIdentity` and so
 * does `crawl/interact.ts` above — a star here is TS2308 on this file, which is
 * how the collision was found rather than claimed. There are in fact THREE
 * functions of that name in the repo, all with different signatures and all
 * correct for their own question:
 *
 *   packages/shared/src/locators.ts       (route, expression)  "has any test
 *                                         asserted on this locator"
 *   packages/agent/src/crawl/interact.ts  ({route, landmark, role, label, nth})
 *                                         the five-part crawl identity, which
 *                                         is what this barrel already publishes
 *   packages/agent/src/flow-diff.ts       (route, kind, label)  keyed on the
 *                                         accessible LABEL rather than the
 *                                         selector, so a restyle that renumbers
 *                                         `.nth(3)` is not an add plus a remove
 *
 * The diff's one stays module-private: it has callers inside flow-diff.ts and
 * nothing outside it needs it, and publishing a fourth meaning of the name
 * through the package's front door would be a trap for whoever imports it next.
 * Everything else flow-diff.ts exports is listed explicitly below, so a new
 * export there is a deliberate decision here rather than a surprise.
 */
export {
  FlowDiffRefused,
  MAX_NAMED_CHANGES,
  baselineIsMeasurable,
  diffFlowMaps,
  driftWorthAnnouncing,
} from './flow-diff.js';
export type {
  FlowDiff,
  FlowDiffCounts,
  FlowDiffDetail,
  FlowDiffFormChange,
  FlowDiffRouteChange,
  FlowDiffSample,
  FlowDiffSide,
  FlowDiffTruncation,
  TestedRoutes,
} from './flow-diff.js';

/*
 * The authorization axis. `authProfile.findFirst(orderBy createdAt asc)` picked
 * ONE identity for the whole crawl and `requiresRoles` was hardcoded `[]`, so
 * authorization coverage had no denominator and "a member gets 403 on /admin"
 * could not be said. `access-matrix.ts` is the route x role matrix behind that
 * sentence, including the NOT_PROBED cells that keep it honest.
 *
 * It is already reached by a real call path — the explore processor imports it —
 * so this line is what makes the SHAPES public for the API's read path.
 */
export * from './access-matrix.js';

/*
 * Mobile screen enumeration. A MOBILE plugin already EXECUTES mobile tests and
 * nothing counted mobile screens, so mobile coverage had no denominator at all:
 * QAAI could run a test on a surface it could not count. `apps/worker` needs
 * `enumerateMobileScreens`, `appiumMobileDevice`, `mobileScreenSurfaceItems`
 * and `mobileReconcileSource` to persist the graph and feed the reconciled
 * surface, and until this line existed the module was tested, unreachable code
 * by this codebase's own definition.
 *
 * It imports `./crawl/interact.js` for values and `./reconcile.js` for types
 * only, both already in this barrel's graph, so it adds no cycle.
 */
export * from './mobile-crawler.js';
