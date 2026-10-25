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
