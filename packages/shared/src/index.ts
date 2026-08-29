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
