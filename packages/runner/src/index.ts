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

/*
 * ── THE SIX TEST TYPES AND THE THREE MODULES BEHIND THEM ────────────────────
 *
 * `check:wiring` reported SEVEN `package-exports` failures at once when this
 * round's agents landed — chaos, document, email, push, pwa, l10n-deep and
 * matrix — every one of them complete, tested and imported by nothing but its
 * own test file. That is this codebase's signature defect reproduced six times
 * in parallel, and for one reason: the registry entry and the barrel line both
 * live in files none of their authors owned.
 *
 * `registry.ts` is what makes the five plugins REACHED, and these lines are
 * what make them PUBLIC. Both halves are needed and they are not the same
 * thing: a module on a barrel and called by nobody is the same dead code with a
 * nicer address, which is why the registry edit came first.
 *
 * Why each of the three non-plugin modules is public API on purpose:
 *
 *   · `matrix.ts` turns a declared cell set into executions and routes each
 *     per-cell verdict onto a `TestResultVariant` row. The worker is the caller
 *     — it owns the execution loop — and it is in a package that cannot reach
 *     this one except through this file.
 *   · `files.ts` is the upload/download step surface: `setInputFiles` appeared
 *     NOWHERE in this runner and nothing asserted a downloaded file's name,
 *     media type or bytes. The harness stages the fixture and the DOCUMENT
 *     plugin asserts the artefact, so both sides import it.
 *   · `l10n-deep.ts` holds the detectors that make a LOCALIZATION finding
 *     possible at all — `FindingKind` has had a `LOCALIZATION` member that
 *     nothing in the repository ever emitted. `plugins/matrix.ts` is the
 *     caller; it is public so the agent can render the detector list beside a
 *     plan item and the web app can label an unmeasured detector.
 *
 * NAME COLLISIONS, checked rather than assumed: `files.ts` and `l10n-deep.ts`
 * both export a `decodeUtf8`-adjacent helper set and neither collides with the
 * other or with the twenty-odd modules already here — verified by typechecking
 * this package with the lines in place, which is what TS2308 would have caught.
 */
export * from './matrix.js';
export * from './files.js';
export * from './l10n-deep.js';
export { chaosPlugin } from './plugins/chaos.js';
export { documentPlugin } from './plugins/document.js';
export { pwaPlugin } from './plugins/pwa.js';
export { pushPlugin } from './plugins/push.js';
export { emailPlugin } from './plugins/email.js';
/*
 * The money path. PUBLIC for one concrete reason beyond symmetry with the five
 * lines above it: the worker is what installs the checkout, gateway-mode,
 * money-state and webhook adapters through `setPaymentsDeps`, and it lives in a
 * package that cannot reach this one except through this file. A plugin whose
 * surfaces can only be installed from inside its own package is a plugin that
 * runs for ever against the `unavailable*` defaults — reporting SKIPPED with a
 * remedy, honestly, and measuring nothing.
 */
export { paymentsPlugin, setPaymentsDeps } from './plugins/payments.js';
