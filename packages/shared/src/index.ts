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
export * from './detect';
export * from './new-test-templates';
export * from './ecosystems';
export * from './flow-map';
export * from './locators';
export * from './types';
export * from './schemas';
export * from './mask';
export * from './job-enums';
export * from './jobs';
