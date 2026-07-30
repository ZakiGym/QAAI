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
  // Any runner QAAI does not implement natively — Vitest, Jest, Cypress, Newman,
  // Pa11y, Maestro… — runs through the external-command plugin and reports via
  // its own JUnit output. UNIT_GEN shares it for the same reason.
  INTEGRATION: externalPlugin,
  UNIT_GEN: { ...externalPlugin, type: 'UNIT_GEN' },
};

/**
 * Types the spec calls for that do not have a plugin in this build. Listed
 * explicitly so the gap is visible in code and in the UI, rather than showing
 * up as a mystery "unsupported type" at run time.
 */
export const UNIMPLEMENTED_TYPES: Partial<Record<TestType, string>> = {
  EMAIL_OTP: 'The demo SMTP catcher exists; the plugin that drives it does not (§4)',
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
