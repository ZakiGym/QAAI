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

/*
 * ── THE DIMENSION MODULES ───────────────────────────────────────────────────
 *
 * Five modules, measuring nine of the keystone's thirteen axes between them.
 * Every one was flagged `package-exports` by `check:wiring` the moment it
 * landed — built, tested, and reachable from nothing but its own test file,
 * which is this codebase's signature defect. These lines are what make them
 * reachable, and `coverage.ts`'s dimension registry is what makes them REACHED:
 * the registry imports all five, so the modules are on a real call path as well
 * as on this barrel.
 *
 * `coverage-rollup.ts` was never flagged, because `coverage-async.ts` already
 * imports `dominantRollupReason` from it. It is listed anyway: the rollup ROWS
 * are what apps/api writes to `CoverageRollup` and what the digest and the PR
 * comment read, and a shape half of whose consumers cannot import it is how one
 * screen comes to disagree with another about the same percentage.
 *
 * ── THE NAME COLLISIONS, CHECKED RATHER THAN CLAIMED ────────────────────────
 *
 * Two were resolved by their authors before landing and are recorded here so
 * the next person does not re-introduce them:
 *
 *   · `UnmeasuredBreakdown` — coverage-fields.ts owns the name
 *     (`Record<DimensionUnmeasuredReason, number>`); coverage-states.ts renamed
 *     its own differently-shaped one to `StateUnmeasuredBreakdown`. Two of
 *     those under one name in a star export is TS2308 on this file and breaks
 *     the barrel for every consumer.
 *   · `dominantUnmeasuredReason` (coverage-matrix.ts) and
 *     `dominantRollupReason` (coverage-rollup.ts) are the same plurality rule
 *     and the same tie-break implemented twice. They do not collide, so the
 *     barrel compiles; ONE of them should survive, and the consolidation is in
 *     this round's handover rather than done by reaching into two files at once.
 *
 * Order follows the import graph so no line adds a cycle this barrel did not
 * already have: `coverage-rollup.ts` first (imported by coverage-async.ts),
 * then the four that import `coverage.js`, `surface-inventory.js` and
 * `access-matrix.js`, all of which are above.
 */
export * from './coverage-rollup.js';
export * from './coverage-states.js';
export * from './coverage-fields.js';
export * from './coverage-matrix.js';
export * from './coverage-async.js';

/*
 * ── THE SCENARIO-DEPTH MODULES ──────────────────────────────────────────────
 *
 * Seven modules, and `check:wiring` flagged every single one of them under
 * `package-exports` the moment it landed: built, typechecked, documented as
 * serving a producer, and reachable from nothing but its own test file. That is
 * this codebase's signature defect and these lines are half the cure; the other
 * half is that each module is also REACHED by a real call path, which is what
 * `explorer.ts`, `coverage.ts` and `generator.ts` do in this same change. A
 * barrel line alone would make them public and still uncalled, which is a
 * prettier shape of the same defect.
 *
 * What each one buys, in the order the plan consumes them:
 *
 *   `synthetic-factory`  the seeded, locale-aware value factory plus the
 *                        uniqueness audit and the cleanup ledger. Three comments
 *                        in this repo promised a faker-based generator; this and
 *                        `@qaai/shared`'s `synthetic.ts` are it, so a generated
 *                        test stops inventing literals that collide.
 *   `walks`              routes walked in two states, re-entered, looped, and
 *                        driven through browser BACK — the shapes a
 *                        first-discovery spanning path cannot express.
 *   `fault-scenarios`    fault injection AND the race/replay/double-submit
 *                        scenarios. A submit button was one click; two in flight
 *                        is where money bugs live.
 *   `auth-lifecycle`     the fourteen flows nothing had ever driven — signup,
 *                        logout, session expiry, password reset, lockout — each
 *                        against a principal it proved disposable FIRST.
 *   `multi-actor`        invite-and-accept and submit-and-approve: two sessions
 *                        in one scenario, which one storageState made
 *                        inexpressible.
 *   `authz-probe`        the IDOR sweep that asks AS A REAL TENANT instead of
 *                        anonymously, which is the only version of the question
 *                        that can fail on a real application.
 *   `gap-closure`        the (route, role) closure join, so closing an
 *                        UNREACHED_AUTH_ROUTE gap stops RE-CREATING it.
 *
 * ── ORDER AND CYCLES, CHECKED ───────────────────────────────────────────────
 *
 * Last in the file on purpose. `fault-scenarios` and `walks` import
 * `coverage-states.js`, `gap-closure` imports `coverage.js` and
 * `access-matrix.js`, `multi-actor` imports `access-matrix.js` — every one of
 * those is above, so no line here introduces a cycle this barrel did not
 * already have.
 *
 * ── NAME COLLISIONS ────────────────────────────────────────────────────────
 *
 * None: the seven modules' exported names were diffed against the 1,319 names
 * this barrel already published, against each other pairwise, and against the
 * three modules the shared barrel gained in this same change. `tsc -p
 * packages/agent/tsconfig.json` reports no TS2308 on this file, which is how the
 * absence was established rather than asserted.
 *
 * One near-miss recorded so nobody re-introduces it: `authz-probe.ts` and
 * `packages/runner/src/plugins/tenancy.ts` both export `CONTROL_STATES`,
 * `ControlState` and `CONTROL_STATE_DETAIL`. They are in DIFFERENT packages, so
 * neither barrel is TS2308 today — and a consumer that imports both @qaai/agent
 * and @qaai/runner must alias one. They are also genuinely two questions: the
 * agent's is "did the control request prove the endpoint is live", the runner's
 * is "was the control attempted at all".
 */
/*
 * ── THE CRAFT MODULES ───────────────────────────────────────────────────────
 *
 * Six modules, and `check:wiring` flagged `artifacts.ts`, `corrections.ts` and
 * `refactor.ts` under `package-exports` the moment they landed: built,
 * typechecked, documented as serving the generator, and reachable from nothing
 * but their own test files. That is this codebase's signature defect and these
 * lines are half the cure; the other half is that every one of them is also
 * REACHED by a real call path, which is what `generator.ts`,
 * `apps/worker/src/processors/generate.ts` and `apps/api/src/routes/agent.ts`
 * do in this same change. A barrel line alone would make them public and still
 * uncalled, which is a prettier shape of the same defect.
 *
 * `style-learner.ts`, `page-objects.ts` and `untrusted.ts` were NOT flagged,
 * and that is the part worth recording: `corrections.ts` imports the first,
 * `artifacts.ts` imports the second and `importer.ts` imports the third, so the
 * ratchet reads them as reached while the front door is shut — rule E, "it has
 * tests is not a read path", in its quieter form. They are listed because their
 * SHAPES are what apps/api and apps/worker have to speak: the ownership
 * verdicts, the exemplar selection, the fenced span.
 *
 * What each one buys:
 *
 *   `untrusted`      the fence. Customer source, page text, commit messages and
 *                    review comments reach a prompt through `composePrompt` or
 *                    not at all, and `UntrustedSpan` has no string member, so
 *                    the next call site gets a compile error rather than
 *                    repeating the defect quietly.
 *   `style-learner`  the model-free house-style profile and the exemplar
 *                    selector. A test in the project's own dialect is the one a
 *                    reviewer keeps.
 *   `corrections`    the correction corpus: what reviewers always change about
 *                    what we write, which has been sitting in
 *                    `TestVersion.source` unread for the life of the product.
 *   `page-objects`   the page object synthesised from the crawl, with its
 *                    locator brittleness and its quoters.
 *   `artifacts`      which files one generated test IS, and where they go —
 *                    from their ledger and their layout, never from ours.
 *   `refactor`       the only path from a suite-health finding to a change.
 *                    Extract a fixture, merge near-duplicates, strengthen an
 *                    assertion — each with a revert record carrying the BYTES.
 *
 * ── ORDER AND CYCLES, CHECKED ───────────────────────────────────────────────
 *
 * Import order: `untrusted` depends on nothing, `style-learner` on
 * `ecosystems`/`dialect` in @qaai/shared, `corrections` on `style-learner` and
 * `ecosystem-prompts`, `page-objects` on @qaai/shared, `artifacts` on
 * `page-objects` and `ecosystem-prompts`, `refactor` on `suite-health` and
 * `dialect`. Every one of those is above or beside it, so no line adds a cycle.
 * None of the six imports a `node:` builtin — verified by grep, not asserted —
 * so none can break a consumer that bundles this package.
 *
 * ── THE ONE NAME THAT COLLIDES, AND IT IS RESOLVED RATHER THAN CLAIMED ──────
 *
 * `__internal`. `admission.ts` (above) and `refactor.ts` both export a
 * test-only bag under that name, which makes a star export of the second TS2308
 * on this file — which is how the collision was found rather than asserted. The
 * explicit re-export below chooses `admission.ts`'s, which this barrel already
 * published, so nothing that compiles today stops compiling;
 * `refactor.test.ts` reaches its own by relative path and is unaffected.
 *
 * Two near-misses recorded so nobody re-introduces them, both already resolved
 * by their authors: `CorrectionPattern` (published by `triage.ts` for a
 * from→to verdict override) became `ReviewerPattern` in `corrections.ts`, and
 * `namingOf` (`artifacts.ts`, over a profile) is distinct from
 * `namingConventionOf` (`style-learner.ts`, over a path). `tsc -p
 * packages/agent/tsconfig.json` reports no other TS2308 on this file.
 */
/*
 * `suite-health.js` was NEVER in this barrel, and the consequence is recorded
 * in apps/api/src/routes/agent.ts, which reaches `SuiteHealthTestInput` by a
 * relative path across the workspace boundary with a comment saying it is
 * type-only for exactly that reason. `refactorFeed` is a VALUE that same file
 * now needs — the only path from a suite-health finding to a change — so the
 * front door is opened rather than a second runtime relative import being
 * added.
 *
 * It must go ABOVE `refactor.js`, which imports it, and above `artifacts.js`
 * for readability; `admission.js` (further up) already imports it, so this line
 * adds no cycle it did not have. No name collides: checked against this
 * barrel's existing graph and confirmed by `tsc -p packages/agent/tsconfig.json`
 * reporting no TS2308 on this file.
 */
export * from './suite-health.js';
/*
 * ONE NAME COLLIDES AND IT IS RESOLVED RATHER THAN CLAIMED. `traffic.js` and
 * `suite-health.js` both export a `JourneyCoverage`, which makes the star above
 * TS2308 on this file — which is how the collision was found. They are two
 * different questions: traffic's is "how much of this journey did real users
 * take", suite-health's is "how much of it does the suite walk". The line below
 * keeps `traffic.js`'s, which this barrel has published for several rounds, so
 * nothing that compiles today stops compiling; suite-health's stays reachable
 * by relative path from its own tests and from `refactor.ts`, which imports it
 * directly.
 */
export type { JourneyCoverage } from './traffic.js';
export * from './untrusted.js';
export * from './style-learner.js';
export * from './corrections.js';
export * from './page-objects.js';
export * from './artifacts.js';
export * from './refactor.js';
export { __internal } from './admission.js';

export * from './synthetic-factory.js';
export * from './walks.js';
export * from './fault-scenarios.js';
export * from './auth-lifecycle.js';
export * from './multi-actor.js';
export * from './authz-probe.js';
export * from './gap-closure.js';

/*
 * ── THE FOUR CLOSURE MODULES THIS ROUND LANDED ──────────────────────────────
 *
 * Every one of them is imported by something that is NOT a test and NOT this
 * barrel, which is the only thing that makes these four lines worth anything.
 * Where each one is actually consumed, VERIFIED rather than planned:
 *
 *   · `known-issues.js` and `env-issue.js` — apps/worker/src/processors/
 *     triage.ts (`matchKnownIssue`, `classifyEnvironment`,
 *     `envIssueSuppression`).
 *   · `mutant-closure.js` — apps/worker/src/processors/mutant-closure.ts,
 *     registered on `MUTANT_CLOSURE_QUEUE` in apps/worker/src/index.ts.
 *   · `drift.js` — apps/api/src/routes/suite-health.ts, as
 *     `GET /suite-health/:projectId/drift`. NOT processors/explore.ts, which is
 *     what this comment said for a round while nothing imported the module at
 *     all: a request is a stronger door than a crawl tick, because a human can
 *     ask the question.
 *
 * Until these lines existed `check:wiring` reported all four `package-exports`
 * disconnected — "nothing but a test file imports it" — which is this
 * codebase's signature defect stated by the ratchet itself. The lines alone are
 * NOT the fix: a barrel export plus a colocated test satisfies that ratchet and
 * reaches no request, which is how `drift.js` sat here for a round with 765
 * lines and no caller.
 *
 * ORDER: `known-issues.js` imports from `./triage.js` (the cluster vocabulary)
 * and `env-issue.js` from `./untrusted.js`, both published above, so no line
 * here adds a cycle.
 *
 * NAME COLLISIONS, CHECKED BOTH WAYS AND NOT ASSUMED. Every exported name in
 * the four files was greped against every `export const|function|interface|
 * type|class` already reachable from this barrel. The near-misses worth
 * recording, because each one is two different questions under one word and a
 * future star export of a fifth module could collide with either:
 *   · `DriftWarning`/`DriftCheck`/`driftCheck` belong to `obsolete.js` (a
 *     retirement-grade audit) while `DRIFT_STATES`/`driftReport` belong to
 *     `drift.js` (per-locator repairability). Different shapes, no shared name.
 *   · `RetirementProposal` is obsolete.js's interface; `drift.js` exports no
 *     such name, and @qaai/shared publishes neither.
 *   · `MUTANT_CLASSES` (mutant-closure.js) against `mutation-gate.js`'s score
 *     vocabulary: no overlap.
 * `tsc -p packages/agent/tsconfig.json` reports no TS2308 on this file.
 */
export * from './known-issues.js';
export * from './env-issue.js';
export * from './drift.js';
export * from './mutant-closure.js';
