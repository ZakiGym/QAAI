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
