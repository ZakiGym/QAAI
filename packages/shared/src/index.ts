/*
 * Internal imports here are EXTENSIONLESS, unlike the `./x.js` NodeNext idiom
 * the sibling packages use. This package is the one the web app's bundler
 * consumes at runtime: Turbopack resolves `./constants.js` literally (the file
 * does not exist — the source is `.ts`) and a barrel whose every re-export
 * fails resolves to a module with no exports at all, 500ing any page that
 * imports a value from @qaai/shared. Extensionless is the native style for the
 * repo's `moduleResolution: Bundler`, and every real execution path — tsx in
 * the API/worker Dockerfiles, vitest, Next — resolves it; nothing executes
 * this package's source under plain Node.
 */
export * from './constants';
export * from './codebase';
export * from './detect';
export * from './new-test-templates';
export * from './ecosystems';
export * from './flow-map';
export * from './surface';
export * from './locators';
export * from './types';
export * from './schemas';
export * from './mask';
export * from './failure-summary';
export * from './plugin-capabilities';
export * from './webhook-failure';
export * from './job-enums';
export * from './jobs';
/*
 * The event-action vocabulary. It is a PUBLIC contract — the API validates a
 * subscription against it and the web app renders the labels from it — and
 * neither could import it while it was missing from this barrel. Safe to add
 * here specifically because `action-events.ts` holds types, constants and pure
 * functions only: no `node:crypto`, no `node:dns`, nothing the web bundler
 * would choke on. The dispatcher that does have those lives in the worker.
 */
export * from './action-events';
export * from './dialect';
/*
 * The synthetic data factory and the third-party test-value catalogue (§2).
 *
 * Public API on purpose: the agent generates values with the first, the runner
 * and the generated specs quote the second, and the web app renders the
 * catalogue's confidence note so a reader can see which card numbers this repo
 * actually vouches for. Both are pure data and arithmetic — no node: builtins —
 * so the web bundler can eat them, which is the test this barrel applies.
 */
export * from './synthetic';
export * from './test-values';
/*
 * The two non-crawl enumeration vocabularies: the surface a HUMAN declared
 * (requirements, acceptance criteria, manual test cases) and the surface an
 * ARTIFACT declares (API operations, components, background surfaces, observed
 * traffic).
 *
 * Public API because they are a CONTRACT between packages that cannot see each
 * other's source: the importers and readers live in packages/agent and
 * apps/worker, the rows live in apps/api, and the traceability matrix and the
 * component-state counts are rendered by the web app. A vocabulary half of
 * whose consumers cannot import it is how three disjoint inventories of one
 * application came to sit on three screens with no combined figure.
 *
 * Both pass this barrel's standing test — pure types, data and arithmetic plus
 * zod, which `schemas.ts` already puts in here, and no `node:` builtin. The
 * content hash in requirements.ts takes its digest as an INJECTED function for
 * exactly that reason: importing `node:crypto` here would 500 every page that
 * reads a value from @qaai/shared, which is why plugin-manifest.ts is reachable
 * only by subpath.
 */
export * from './requirements';
export * from './api-surface';
/*
 * The auth-profile vocabulary: the three new profile kinds and their config
 * shapes, the capability gaps that make a kind UNAVAILABLE rather than failed,
 * the route x role access outcomes, and the bot-protection reachability states.
 *
 * Public API for the same reason as the two above, and more sharply: the write
 * path lives in apps/api, the adapters in packages/runner, the matrix builder
 * in packages/agent, and the profile editor in apps/web. Until this line
 * existed, login.ts and playwright-harness.ts reached the module by relative
 * path across the package boundary — which compiles, and quietly means the
 * parity guard's compiler half is enforced on a file nobody imports as a
 * package.
 *
 * Passes this barrel's standing test: zod, local modules, no `node:` builtin.
 */
export * from './auth-profiles';
/*
 * The one row builder both result-ingest paths call, so that a customer's
 * variant matrix and metric readings do not depend on whether they ran the
 * on-prem agent or the cloud worker.
 *
 * Public API because that is the ONLY thing that makes the two doors provably
 * the same: apps/api's runners route and apps/worker's run processor cannot
 * import each other, and for one slice this builder was duplicated byte for
 * byte in both of them, held together by a test that read both files off disk.
 * A builder half of whose callers cannot import it is how one customer's matrix
 * comes to disagree with another's.
 *
 * Passes this barrel's standing test: types, pure arithmetic and string
 * building, no zod and no `node:` builtin.
 */
export * from './measurement-rows';
/*
 * The coverage LADDER, the coverage DIMENSIONS and the ATTESTATION envelope.
 *
 * All three are contracts between packages that cannot see each other's source,
 * which is the test this barrel applies: `coverage-tiers.ts` is the rung
 * vocabulary the agent's measurements are expressed in, the API's write paths
 * validate against and the web app renders; `coverage-dimensions.ts` is the
 * axis vocabulary six dimension modules in packages/agent, the rollup writer in
 * apps/api and the preflight prober in apps/worker all have to mean the same
 * thing by; `attestation.ts` is the envelope the export route builds and the
 * digest signs. Until these lines existed, `COVERAGE_DIMENSIONS`,
 * `measuredDimension`, `dimensionPercentAt` and `attest` were reachable only by
 * relative path ACROSS the workspace boundary — which compiles, bypasses the
 * package entry point, and leaves the keystone's compiler-enforced presence
 * records enforced on files nobody imports as a package. Nine files did exactly
 * that in one round.
 *
 * All three pass this barrel's standing test: types, closed vocabularies and
 * pure arithmetic, plus zod in neither of them and no `node:` builtin anywhere
 * — `attestation.ts` takes its digest as an INJECTED `ContentDigest` for
 * precisely that reason, so importing it here cannot 500 a page that reads a
 * value from @qaai/shared.
 *
 * Order is deliberate: `coverage-tiers` first, because the other two import
 * `CoverageLadder` and `CoverageTier` from it.
 */
export * from './coverage-tiers';
export * from './coverage-dimensions';
export * from './attestation';
