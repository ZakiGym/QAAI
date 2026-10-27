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
/*
 * ── THE SIX TEST TYPES THIS ROUND LANDED ───────────────────────────────────
 *
 * Every one of them arrived in the state `check:wiring` names `package-exports`
 * — complete, tested, and imported by nothing but its own test file. Seven
 * files were in that state at once, which is this codebase's signature defect
 * reproduced six times in parallel because the registry entry lives in a file
 * none of their authors owned. These imports and the table below are what make
 * them REACHED; the barrel line in index.ts only makes them public, which is
 * the same dead code with a nicer address.
 *
 * All six go in `PENDING_PLUGINS` rather than `PLUGINS`, and that is not
 * caution: each one's `type` is a string literal `TEST_TYPES` does not contain,
 * so no `Test` row can carry it and no run can resolve to it. Forcing one into
 * an existing type to make it reachable sooner would validate its spec against
 * the wrong schema and report what failed under a name that does not describe
 * it. `promotePendingPlugins` moves each the day its member is minted.
 */
import { chaosPlugin } from './plugins/chaos.js';
import { documentPlugin } from './plugins/document.js';
import { pushPlugin } from './plugins/push.js';
import { pwaPlugin } from './plugins/pwa.js';
/*
 * EMAIL is the one whose NAME is a problem, recorded here rather than fixed
 * silently. `emailPlugin.type` is the literal `'EMAIL'`, and `'EMAIL'` is in
 * NEITHER `TEST_TYPES` nor `PENDING_TEST_TYPES` — so unlike its five siblings
 * it has no declaration, `mintTestTypeSteps` cannot be called for it, and
 * `declaredRequirements` below returns an empty list with a reason rather than
 * a requirement set. The plugin's own header argues for the spelling (it
 * matches `SurfaceDimensionKind`'s `EMAIL`, the surface it covers) and that
 * argument is sound; what is missing is the member in
 * packages/shared/src/constants.ts, which is in this round's handover. It is
 * registered anyway, because `pendingTypes()` naming it is strictly better
 * than a plugin no gate can see.
 */
import { emailPlugin } from './plugins/email.js';

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
  /*
   * CHAOS — a dependency misbehaving, driven through the route interception
   * `har.ts` has always had and no test type ever used. Reads BOTH its own
   * wider fault vocabulary and the shared `chaosTestSpecSchema`, so a stored
   * row runs today and the gap between the two is a number it exports rather
   * than a surprise.
   */
  CHAOS: chaosPlugin,
  /*
   * DOCUMENT — a produced file: an invoice, a statement, a label, a signed
   * contract, an export. `setInputFiles` appeared nowhere in this runner and
   * nothing anywhere asserted a downloaded file's name, media type or bytes, so
   * "the button worked" was the strongest claim available about a download.
   */
  DOCUMENT: documentPlugin,
  /*
   * PWA — the service worker, offline navigation, cache-first behaviour and the
   * install prompt: a second, cached copy of the application that no online
   * test has ever executed.
   */
  PWA: pwaPlugin,
  /*
   * PUSH — a notification actually DELIVERED, over Web Push, APNs or FCM.
   * Mobile tests stopped at the app's own UI; nothing triggered or asserted a
   * delivery. A device-bound transport with no customer-owned sender reports
   * UNAVAILABLE rather than SKIPPED, which is the distinction that keeps a
   * percentage from counting a test that can never run.
   */
  PUSH: pushPlugin,
  /*
   * EMAIL — a transactional message's own delivery and content, as opposed to
   * EMAIL_OTP, which drives a sign-in. See the import note: this key is the one
   * of the six with no declared member behind it.
   */
  EMAIL: emailPlugin,
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

/*
 * ── THE DECLARATION BRIDGE: ONE ANSWER TO "WHAT DOES THIS TYPE NEED" ────────
 *
 * THE DEFECT. There were TWO tables of requirements and they covered different
 * types. `TYPE_REQUIREMENTS` in ./preflight.ts is a `Record<TestType, …>` — the
 * nineteen MINTED types, and the only one the prober can read. The keystone's
 * `TEST_TYPE_DECLARATIONS` / `PENDING_TEST_TYPE_DECLARATIONS` in
 * packages/shared/src/test-type-decl.ts cover all THIRTY, including the eleven
 * pending ones whose plugins this file now registers.
 *
 * So `runnabilityReport()` could not answer for CHAOS, DOCUMENT, PWA or PUSH at
 * all — not "unknown", not "pending": the call did not typecheck, and a caller
 * asking "can this deployment run the six types you just shipped" got nothing
 * back. A plugin registered and un-probeable is the preflight failing at
 * exactly the moment it exists for.
 *
 * This bridge reads the DECLARATION and hands it to the prober, so the two
 * tables stop being two answers. `requirementParity` below is the guard that
 * keeps them one answer for the minted overlap: if somebody edits one table
 * only, that function names the type rather than leaving a deployment with two
 * different beliefs about what MOBILE needs.
 */

import type { TypeRequirement } from '@qaai/shared';
import { ANY_TEST_TYPES, declarationFor, requirementsForType } from '@qaai/shared';
import type { Requirement } from './preflight.js';
import { TYPE_REQUIREMENTS } from './preflight.js';

/**
 * A declared requirement, in the shape the prober understands.
 *
 * ── THE ONE LOSSY CASE, AND WHY IT IS A DEMOTION RATHER THAN A DROP ─────────
 *
 * `TypeRequirement` has a `CHANNEL` member that `Requirement` does not, because
 * nothing in ./preflight.ts can probe for Chrome Beta: the prober asks
 * Playwright which ENGINES are installed, and a channel is a separate browser
 * on the host that Playwright reports nothing about. The three available
 * treatments are not equal:
 *
 *   · DROP IT — a cap applied without being disclosed, and the worst of the
 *     three: the report would say MOBILE is runnable having silently stopped
 *     asking about the thing that would stop it.
 *   · KEEP IT AS TYPE-SCOPED — the prober would report it ABSENT (it cannot
 *     see it) and REFUSE a type whose channel is installed. "QAAI refused my
 *     Chrome stable" is worse than "QAAI did not check it and said so".
 *   · DEMOTE IT TO `UNPROBED` AT SPEC SCOPE — reported in `degraded`, never a
 *     refusal, with the channel named and the real answerer pointed at. That
 *     is what this does, and {@link CHANNEL_REQUIREMENTS_DEMOTED} makes the
 *     count sayable so the demotion is disclosed rather than discovered.
 *
 * `resolveMatrixCell` in packages/shared/src/browser-matrix.ts is the function
 * that DOES answer for a channel, against a `DeploymentBrowsers` capability the
 * worker collects. It reports NEEDS_BROWSER_GRID and UNSUPPORTED_COMBINATION,
 * which no amount of installing changes — two outcomes this prober's four
 * statuses cannot express, which is the deeper reason the two live apart.
 */
export function asProbeRequirement(requirement: TypeRequirement): Requirement {
  if (requirement.kind !== 'CHANNEL') return requirement;
  return {
    kind: 'UNPROBED',
    scope: 'SPEC',
    what: `the \`${requirement.channel}\` browser channel (${requirement.install})`,
    why:
      'this prober asks Playwright which ENGINES are installed and a channel is a separate ' +
      'browser on the host it reports nothing about. `resolveMatrixCell` in ' +
      '@qaai/shared/browser-matrix answers for a channel against a collected ' +
      'DeploymentBrowsers capability — including NEEDS_BROWSER_GRID and ' +
      'UNSUPPORTED_COMBINATION, which no install fixes and which this prober cannot express.',
  };
}

/** How many declared CHANNEL requirements were demoted, per type. Disclosed, never silent. */
export function CHANNEL_REQUIREMENTS_DEMOTED(): Array<{ type: string; channels: string[] }> {
  const out: Array<{ type: string; channels: string[] }> = [];
  for (const type of ANY_TEST_TYPES) {
    const channels = requirementsForType(type)
      .filter((requirement): requirement is Extract<TypeRequirement, { kind: 'CHANNEL' }> =>
        requirement.kind === 'CHANNEL',
      )
      .map((requirement) => requirement.channel);
    if (channels.length > 0) out.push({ type, channels });
  }
  return out;
}

/**
 * What a type declares it needs, minted or not, in the prober's shape.
 *
 * Returns an EMPTY list with a reason — never a fabricated requirement set —
 * for a name with no declaration. `'EMAIL'` is exactly that case today: a
 * registered plugin whose type string is in neither `TEST_TYPES` nor
 * `PENDING_TEST_TYPES`, so there is nothing to read. Answering with `[]` and no
 * distinction would say "this type needs nothing", which is what API and
 * SECURITY_SMOKE genuinely report, so the two are kept apart by `declared`.
 */
export function declaredRequirements(type: string): {
  readonly declared: boolean;
  readonly requirements: readonly Requirement[];
  readonly why: string;
} {
  const declaration = declarationFor(type);
  if (declaration === null) {
    return {
      declared: false,
      requirements: [],
      why:
        `"${type}" has no entry in TEST_TYPE_DECLARATIONS or ` +
        'PENDING_TEST_TYPE_DECLARATIONS, so what it needs is UNKNOWN rather than nothing. A ' +
        'plugin is registered under this name and no declaration describes it — add the member ' +
        'to TEST_TYPES or PENDING_TEST_TYPES in packages/shared/src/constants.ts and the ' +
        'declaration beside it.',
    };
  }
  return {
    declared: true,
    requirements: declaration.requirements.map(asProbeRequirement),
    why: declaration.summary,
  };
}

/**
 * Runnability for ANY declared type, pending ones included.
 *
 * The same answer `runnabilityReport` gives for the nineteen, extended to the
 * thirty by reading the declaration instead of `TYPE_REQUIREMENTS`. A name with
 * no declaration is REFUSED rather than answered — see `declaredRequirements` —
 * because the one thing worse than "unknown" here is a confident "runnable"
 * about a type nobody described.
 *
 * The cast on `types` is narrow and load-bearing, and it is the same shape as
 * the one `PENDING_PLUGINS` uses above: `checkRunnability` reads a type only as
 * a `Record` key and as a string in its sentence, and every key is checked
 * against the declarations immediately below, so nothing is answered under a
 * name the declarations do not hold.
 */
export function declaredRunnability(
  types: readonly string[],
  options: {
    probes?: RunnabilityProbes;
    hasPlugin?: (type: string) => boolean;
  } = {},
): Promise<TypeRunnability[]> {
  const requirements: Partial<Record<TestType, readonly Requirement[]>> = {};
  const undeclared: string[] = [];
  for (const type of types) {
    const declared = declaredRequirements(type);
    if (!declared.declared) {
      undeclared.push(type);
      continue;
    }
    requirements[type as TestType] = declared.requirements;
  }

  const hasPlugin =
    options.hasPlugin ??
    ((type: string) =>
      PLUGINS[type as TestType] !== undefined || Object.keys(PENDING_PLUGINS).includes(type));

  return checkRunnability(types.filter((type) => !undeclared.includes(type)) as TestType[], {
    probes: options.probes,
    requirements,
    pluginless: (type) =>
      hasPlugin(type)
        ? null
        : `${reasonUnsupported(type)} — no amount of installing tools on this worker changes that.`,
  });
}

/**
 * Where the two requirement tables DISAGREE about a minted type.
 *
 * Exported and empty-on-purpose: two hand-maintained answers to "what does
 * MOBILE need" is how one of them starts being wrong, and the one that would be
 * wrong is whichever a reader is not looking at. A test asserts this is empty,
 * so editing one table alone fails rather than shipping a deployment with two
 * beliefs.
 *
 * Compares the SET of (kind, name) pairs rather than the objects: the
 * declaration carries a `why` the prober's table does not always repeat, and a
 * difference in prose is not a difference in what must be installed.
 */
export function requirementParity(): Array<{ type: TestType; only: string[] }> {
  const key = (requirement: Requirement): string =>
    requirement.kind === 'BINARY'
      ? `BINARY:${requirement.name}`
      : requirement.kind === 'BROWSER'
        ? `BROWSER:${requirement.name}`
        : requirement.kind === 'PLATFORM'
          ? `PLATFORM:${requirement.platform}`
          : `UNPROBED:${requirement.what}`;

  const out: Array<{ type: TestType; only: string[] }> = [];
  for (const type of Object.keys(TYPE_REQUIREMENTS) as TestType[]) {
    const fromTable = new Set(TYPE_REQUIREMENTS[type].map(key));
    const fromDecl = new Set(declaredRequirements(type).requirements.map(key));
    const only = [
      ...[...fromTable].filter((entry) => !fromDecl.has(entry)).map((entry) => `preflight:${entry}`),
      ...[...fromDecl].filter((entry) => !fromTable.has(entry)).map((entry) => `declaration:${entry}`),
    ].sort();
    if (only.length > 0) out.push({ type, only });
  }
  return out;
}

/**
 * Registered plugins whose type string no declaration describes.
 *
 * The gap `'EMAIL'` is in today, as a countable value rather than a comment. A
 * plugin here is reachable (`pendingTypes()` names it) and un-probeable
 * (`declaredRequirements` refuses it), which is a different and smaller gap
 * than a plugin nothing imports — and it is the one state this round could not
 * close without editing packages/shared/src/constants.ts.
 */
export function undeclaredPluginTypes(): string[] {
  const names = [...Object.keys(PLUGINS), ...Object.keys(PENDING_PLUGINS)];
  return [...new Set(names)].filter((name) => declarationFor(name) === null).sort();
}

/**
 * Types that must be EXCLUDED from a coverage denominator, each with a reason.
 *
 * ── THE LIE THIS EXISTS TO STOP ─────────────────────────────────────────────
 *
 * A percentage whose denominator contains a type this image cannot execute is a
 * percentage containing tests that can never fail. Before the preflight existed
 * the product discovered a missing k6 one run at a time and recorded the result
 * SKIPPED — and a SKIPPED row inside a denominator is indistinguishable from a
 * surface nobody has got to yet.
 *
 * So the exclusion is a LIST OF REASONS, not a filter. Every caller that drops
 * a type from a denominator has the sentence to print beside the number, and a
 * type dropped with no sentence is not expressible here.
 *
 * `runnable === null` is NOT excluded, and that is the subtle half: nothing was
 * probed, which is not evidence that the type cannot run. Excluding it would
 * let a deployment that never ran a preflight shed every type it could not
 * prove it could run, and the percentage would RISE for a probe nobody
 * executed — the same rule `UNEXERCISABLE_CELL_STATUSES` records for a matrix
 * cell in packages/runner/src/matrix.ts.
 */
export function denominatorExclusions(
  runnability: readonly TypeRunnability[],
): Array<{ type: TestType; reason: string }> {
  const out: Array<{ type: TestType; reason: string }> = [];
  for (const entry of runnability) {
    if (entry.runnable !== false) continue;
    const missing = entry.missing.map((requirement) =>
      requirement.kind === 'BINARY'
        ? `\`${requirement.name}\` is not installed — ${requirement.install}`
        : requirement.kind === 'BROWSER'
          ? `Playwright's ${requirement.name} is not installed — ${requirement.install}`
          : requirement.kind === 'PLATFORM'
            ? `this worker is not ${requirement.platform}`
            : requirement.what,
    );
    const wrong = entry.wrongVersion.map((requirement) =>
      requirement.kind === 'BINARY'
        ? `\`${requirement.name}\` is installed and outside its declared window — upgrade it`
        : 'a declared version window is unmet',
    );
    out.push({
      type: entry.type,
      reason:
        missing.length + wrong.length > 0
          ? `${entry.type} cannot run on this deployment: ${[...missing, ...wrong].join('; ')}. ` +
            'It is OUT of the coverage denominator, so the percentage is over what this ' +
            'deployment can actually execute — it is not reported as passing and not reported ' +
            'as skipped.'
          : entry.reason,
    });
  }
  return out;
}
