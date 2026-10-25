/**
 * The plugin registry (§4). One plugin per test type; the worker resolves a
 * test's `type` to a plugin here and never branches on type itself.
 *
 * Types without a plugin yet resolve to `null`, and the worker records the test
 * as SKIPPED with a readable reason rather than failing the whole run. That is
 * deliberate: a suite containing one LOAD test should still produce E2E results.
 */

import type { RunnerPlugin, TestType } from '@qaai/shared';
import { ALL_TEST_TYPES, checkRunnability } from './preflight.js';
import type { RunnabilityProbes, TypeRunnability } from './preflight.js';
import { e2ePlugin } from './plugins/e2e.js';
import { smokePlugin } from './plugins/smoke.js';
import { apiPlugin } from './plugins/api.js';
import { accessibilityPlugin } from './plugins/accessibility.js';
import { securitySmokePlugin } from './plugins/security-smoke.js';
import { loadPlugin } from './plugins/load.js';
import { externalPlugin } from './plugins/external.js';
import { visualPlugin } from './plugins/visual.js';
import { crossBrowserPlugin, localizationPlugin } from './plugins/matrix.js';
import { emailOtpPlugin } from './plugins/email-otp.js';
import { databasePlugin } from './plugins/database.js';
import { cliPlugin } from './plugins/cli.js';
import { mutationPlugin } from './plugins/mutation.js';
import { contractPlugin } from './plugins/contract.js';
import { protocolPlugin } from './plugins/protocol.js';
import { mobilePlugin } from './plugins/mobile.js';
import { performancePlugin } from './plugins/performance.js';

const PLUGINS: Partial<Record<TestType, RunnerPlugin>> = {
  E2E: e2ePlugin,
  SMOKE: smokePlugin,
  API: apiPlugin,
  ACCESSIBILITY: accessibilityPlugin,
  SECURITY_SMOKE: securitySmokePlugin,
  LOAD: loadPlugin,
  VISUAL: visualPlugin,
  CROSS_BROWSER: crossBrowserPlugin,
  LOCALIZATION: localizationPlugin,
  EMAIL_OTP: emailOtpPlugin,
  DATABASE: databasePlugin,
  CLI: cliPlugin,
  MUTATION: mutationPlugin,
  CONTRACT: contractPlugin,
  PROTOCOL: protocolPlugin,
  // Appium is driven over its own W3C API; Maestro, Detox, Espresso and
  // XCUITest shell out to their CLIs. All five live behind one plugin because
  // they differ in transport, not in shape.
  MOBILE: mobilePlugin,
  // Any runner QAAI does not implement natively — Vitest, Jest, Cypress, Newman,
  // Pa11y, Maestro… — runs through the external-command plugin and reports via
  // its own JUnit output. UNIT_GEN shares it for the same reason.
  INTEGRATION: externalPlugin,
  UNIT_GEN: { ...externalPlugin, type: 'UNIT_GEN' },
  // Core Web Vitals against a budget. LOAD measures what the server survives;
  // this measures what the person holding the laptop waits for.
  PERFORMANCE: performancePlugin,
};

/**
 * Types the spec calls for that do not have a plugin in this build. Listed
 * explicitly so the gap is visible in code and in the UI, rather than showing
 * up as a mystery "unsupported type" at run time.
 */
export const UNIMPLEMENTED_TYPES: Partial<Record<TestType, string>> = {
  // Every TestType now has a plugin. Kept so a future type has an honest home
  // rather than surfacing as a mystery "unsupported type" at run time.
};

export function pluginFor(type: TestType): RunnerPlugin | null {
  return PLUGINS[type] ?? null;
}

export function reasonUnsupported(type: TestType): string {
  return UNIMPLEMENTED_TYPES[type] ?? `No runner plugin registered for ${type}`;
}

export function implementedTypes(): TestType[] {
  return Object.keys(PLUGINS) as TestType[];
}

/*
 * ── Runnability lives here, on top of the registry ──────────────────────────
 *
 * "Which of the 19 types can this deployment execute?" has two halves, and only
 * one of them is a property of the machine:
 *
 *   1. Is there a plugin for this type at all? Owned by this file.
 *   2. Is the tool that plugin shells out to present on this image? Owned by
 *      ./preflight.ts.
 *
 * Neither half is the answer on its own, and before this the product had the
 * first and discovered the second one run at a time: `load.ts` spawned k6 and
 * read ENOENT, `mobile.ts` tried `xcodebuild` and found out it was not on
 * macOS. A customer writing a LOAD test on an image with no k6 learned about it
 * from a skipped result after waiting for a run.
 *
 * `preflight.ts` is re-exported through here rather than from index.ts: this is
 * the module that already answers "what can run", and the two halves belong
 * behind one import for every caller.
 */
export * from './preflight.js';

/**
 * "Is this type unimplemented?", in the shape `checkRunnability` wants.
 *
 * `hasPlugin` is injectable, and that is not generality for its own sake: a
 * RUN resolves a type through `resolveTestPlugin`, which also consults the
 * project's INSTALLED third-party plugins, so a type with no first-party plugin
 * can still be perfectly runnable for that project. A runnability report that
 * asked only this registry would declare such a type unsupported and the run
 * would then refuse tests it was about to execute — a preflight causing the
 * exact outcome it exists to prevent. Callers that know about installed plugins
 * pass their own answer; callers asking about the DEPLOYMENT get this one.
 */
function pluginlessReason(
  type: TestType,
  hasPlugin: (type: TestType) => boolean = (t) => pluginFor(t) !== null,
): string | null {
  return hasPlugin(type)
    ? null
    : `${reasonUnsupported(type)} — no amount of installing tools on this worker changes that.`;
}

/**
 * What THIS deployment can execute, type by type.
 *
 * Covers every member of `TEST_TYPES` and not merely the ones with plugins, so
 * the report can say "no plugin" and "no k6" in the same list — they are the
 * same question to the person who wrote the test, and splitting them across two
 * surfaces is how one of them ends up on neither.
 *
 * The probes are injectable for tests; in production they are a handful of
 * `stat` calls, cached for the process (see preflight.ts). It is cheap enough
 * to run per run, which is what the run processor does, and cheap enough to
 * serve from an endpoint, which is what the cockpit's "what can this install
 * do" panel needs.
 */
export function runnabilityReport(
  options: { probes?: RunnabilityProbes } = {},
): Promise<TypeRunnability[]> {
  return checkRunnability(ALL_TEST_TYPES, {
    probes: options.probes,
    pluginless: pluginlessReason,
  });
}

/**
 * The same answer for just the types a run selected.
 *
 * A run must not pay to probe Maestro because some other project has mobile
 * tests, and — more importantly — must not report a tooling gap for a type
 * nobody in this run is using. The full report above is for a surface that asks
 * about the deployment; this one is for a surface that asks about a suite.
 */
export function runnabilityFor(
  types: readonly TestType[],
  options: {
    probes?: RunnabilityProbes;
    /** The caller's own plugin lookup — a run's includes installed plugins. */
    hasPlugin?: (type: TestType) => boolean;
  } = {},
): Promise<TypeRunnability[]> {
  return checkRunnability(types, {
    probes: options.probes,
    pluginless: (type) => pluginlessReason(type, options.hasPlugin),
  });
}
