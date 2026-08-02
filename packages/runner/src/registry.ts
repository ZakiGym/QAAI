/**
 * The plugin registry (§4). One plugin per test type; the worker resolves a
 * test's `type` to a plugin here and never branches on type itself.
 *
 * Types without a plugin yet resolve to `null`, and the worker records the test
 * as SKIPPED with a readable reason rather than failing the whole run. That is
 * deliberate: a suite containing one LOAD test should still produce E2E results.
 */

import type { RunnerPlugin, TestType } from '@qaai/shared';
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
