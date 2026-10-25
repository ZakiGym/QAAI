export * from './registry.js';
export * from './browser-pool.js';
export * from './determinism.js';
export * from './child-env.js';
export * from './playwright-harness.js';
export * from './gates.js';
export { e2ePlugin } from './plugins/e2e.js';
export { smokePlugin } from './plugins/smoke.js';
export { apiPlugin } from './plugins/api.js';
export { accessibilityPlugin } from './plugins/accessibility.js';
export { securitySmokePlugin } from './plugins/security-smoke.js';
export { databasePlugin } from './plugins/database.js';
export { cliPlugin } from './plugins/cli.js';
export { contractPlugin } from './plugins/contract.js';
export { protocolPlugin } from './plugins/protocol.js';
export { mutationPlugin } from './plugins/mutation.js';
export { mobilePlugin } from './plugins/mobile.js';
/*
 * The two surfaces QAAI could neither count nor execute against: a desktop
 * shell (multi-window, native menu bar, tray, main-process IPC) and the
 * BACKGROUND_JOB axis, which `SURFACE_KINDS` has had a member for all along
 * with nothing able to cover it.
 *
 * Listed here for the same reason as the eleven lines above it and not because
 * anything was unreachable: `registry.ts` already imports both into
 * `PENDING_PLUGINS`, and `export * from './registry.js'` already publishes
 * `pendingTypes` and `promotePendingPlugins`. Both plugins stay PENDING — no
 * run can resolve to either — until `TEST_TYPES` in packages/shared/src/
 * constants.ts and the Prisma `TestType` enum name DESKTOP and JOBS. That pair
 * of edits is in this round's handover; `pendingTypes()` is the read path that
 * reports the gap honestly in the meantime.
 */
export { desktopPlugin } from './plugins/desktop.js';
export { jobsPlugin } from './plugins/jobs.js';
export * from './record.js';
export * from './login.js';
export * from './visual-services.js';

/*
 * The two surfaces this package gained for third-party plugins and for getting
 * results into somebody else's tool. Both were written, tested and imported by
 * nothing — the shape this repo keeps producing, and the shape check:wiring
 * exists to catch.
 *
 * `external-loader` is public on purpose: the API verifies a plugin's signature
 * and the RUNNER verifies its content hash before executing it, and a caller
 * that cannot reach the loader cannot do the second half.
 */
export * from './plugins/external-loader.js';
export * from './plugins/sandbox.js';
export * from './reporters/index.js';
