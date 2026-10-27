/**
 * The plugin registry (§4). One plugin per test type; the worker resolves a
 * test's `type` to a plugin here and never branches on type itself.
 *
 * Types without a plugin yet resolve to `null`, and the worker records the test
 * as SKIPPED with a readable reason rather than failing the whole run. That is
 * deliberate: a suite containing one LOAD test should still produce E2E results.
 */

import type { RunnerPlugin, TestType } from '@qaai/shared';
import { TEST_TYPES } from '@qaai/shared';
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
import { desktopPlugin } from './plugins/desktop.js';
import { jobsPlugin } from './plugins/jobs.js';
import { linksPlugin } from './plugins/links.js';
import { seoPlugin } from './plugins/seo.js';
/*
 * The cross-tenant isolation sweep. Registered here because that is the only
 * thing that makes it reachable: it landed tested and imported by nothing but
 * its own test file, which `check:wiring` flags as `package-exports` and this
 * codebase produces more often than any other defect.
 */
import { tenancyPlugin } from './plugins/tenancy.js';

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

/*
 * ── Plugins whose TestType is not minted yet ────────────────────────────────
 *
 * The usual gap in this table is a type with no plugin. These four are the
 * mirror image: a complete, tested plugin for a type `TEST_TYPES` does not
 * contain. Each covers a whole class of defect that scores zero today —
 * desktop shells (Electron/Tauri/WebView); the `BACKGROUND_JOB` surface kind
 * the inventory has counted since it was built while nothing could execute
 * one; the link and asset edges the crawler discovers and nothing ever asked
 * to resolve; and the metadata layer — title, canonical, hreflang, Open Graph,
 * JSON-LD, robots/sitemap consistency — that was absent from the product
 * entirely.
 *
 * LINKS and SEO are the cheap wide pair: no model, no browser, deterministic,
 * and they apply to every URL a crawl reached. They are PENDING for exactly
 * the same reason as the other two and not for want of anything in this
 * package.
 *
 * `TestType` is the union behind a Postgres enum, `createTestSchema`, the
 * cockpit's filter chips and `NEW_TEST_TEMPLATES`, and minting a member means
 * editing `packages/shared/src/constants.ts` and migrating the enum — files
 * this change does not own. So the plugins land here, and the registry
 * PROMOTES them the moment the vocabulary arrives.
 *
 * Why promotion rather than a second edit later: the alternative is a plugin
 * sitting in the tree with no entry in this table, which is precisely the
 * "module with no caller" defect `check:wiring` exists to catch — and it would
 * be invisible to that gate, because an unminted type is not in the list it
 * iterates. Promotion means the shared edit alone is sufficient: `pluginFor`
 * answers, `implementedTypes()` stays equal to `TEST_TYPES`, and nobody has to
 * remember this file.
 *
 * The cast is narrow and load-bearing. `jobsPlugin.type` is the literal
 * `'JOBS'`, which is not assignable to `TestType` until the union contains it;
 * the KEY is checked against `TEST_TYPES` at run time immediately below, so
 * nothing is ever promoted under a name the union does not have.
 */
type PendingPlugin = Omit<RunnerPlugin, 'type'> & { readonly type: string };

const PENDING_PLUGINS: Readonly<Record<string, PendingPlugin>> = {
  DESKTOP: desktopPlugin,
  JOBS: jobsPlugin,
  LINKS: linksPlugin,
  SEO: seoPlugin,
  /*
   * TENANCY — one tenant's session against another tenant's ids, swept across
   * every enumerated endpoint. The register calls this the bug class that ends
   * a company, and until the per-principal session path landed it was not
   * merely untested but INEXPRESSIBLE: one `storageState` per run meant one
   * cookie jar, so the only version of the question the product could ask was
   * the anonymous one, which every correct application answers with a denial.
   * A check that passes everywhere has never found anything.
   *
   * PENDING RATHER THAN IN `PLUGINS`, and the distinction is the honest one.
   * `tenancyPlugin.type` is the literal `'TENANCY'`, which `TEST_TYPES` does
   * not contain, so no `Test` row can carry that type and no run can resolve to
   * this plugin yet. The two things that change that are a member in
   * `packages/shared/src/constants.ts` and a migrated Prisma `TestType` enum —
   * both in files this change does not own, both named in the handover.
   *
   * It is NOT forced into `SECURITY_SMOKE` to make it reachable sooner. That
   * type's plugin already exists and does something else, and a tenancy spec
   * executed by it would be validated against the wrong schema and reported
   * under a name that does not describe what failed. `pendingTypes()` is the
   * read path that reports this as a known, named gap in the meantime, which is
   * the difference between a surface that is UNEXERCISABLE and one that does
   * not exist.
   */
  TENANCY: tenancyPlugin,
};

/**
 * Move every pending plugin whose type `mintedTypes` now contains into `into`.
 *
 * A function taking both sides rather than a loop closing over `PLUGINS` and
 * `TEST_TYPES`, and that is not tidiness: as a bare loop this code was
 * UNTESTABLE in this build. `TEST_TYPES` does not contain DESKTOP or JOBS, so
 * the body never ran, and a mutation that disabled the whole loop left every
 * test green — the promotion would have been dead on the day the vocabulary
 * landed and nothing would have said so. Passing the minted list in means a
 * test can hand it a widened one and watch the plugin actually arrive.
 */
export function promotePendingPlugins(
  into: Record<string, RunnerPlugin>,
  mintedTypes: readonly string[],
): string[] {
  const moved: string[] = [];
  for (const [name, plugin] of Object.entries(PENDING_PLUGINS)) {
    if (mintedTypes.includes(name)) {
      into[name] = plugin as RunnerPlugin;
      moved.push(name);
    }
  }
  return moved;
}

const promoted = promotePendingPlugins(PLUGINS, TEST_TYPES);

/**
 * Types with a built plugin that `TEST_TYPES` cannot name yet.
 *
 * Exported because the gap has to be SAYABLE. "QAAI cannot test your Electron
 * app" and "QAAI can test your Electron app but you cannot create the test
 * yet" are different sentences with different remedies, and without this the
 * second one reads as the first — which would understate what the product can
 * do while overstating what the customer can reach.
 */
export function pendingTypes(): string[] {
  return Object.keys(PENDING_PLUGINS).filter((name) => !promoted.includes(name));
}

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

/**
 * Why a type cannot run here, in a sentence.
 *
 * The pending branch is not decoration. A caller asking about DESKTOP would
 * otherwise be told "no runner plugin registered", which is false — the plugin
 * is in this build and this table imports it — and would send the reader to
 * write a plugin that already exists. The remedy for these two is minting the
 * TestType, so that is what it says.
 */
export function reasonUnsupported(type: TestType): string {
  const explicit = UNIMPLEMENTED_TYPES[type];
  if (explicit !== undefined) return explicit;

  if (pendingTypes().includes(type)) {
    return (
      `${type} has a runner plugin in this build, but "${type}" is not a member of TEST_TYPES ` +
      'yet — so no test of this type can be stored or created. Add it to TEST_TYPES in ' +
      'packages/shared/src/constants.ts and to the Prisma TestType enum; the registry picks the ' +
      'plugin up with no further change'
    );
  }
  return `No runner plugin registered for ${type}`;
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
