/**
 * The PWA test type (§4) — service worker, offline navigation, cache-first
 * behaviour, background sync and the install prompt.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * Every one of those was untestable. An application that CLAIMS TO WORK OFFLINE
 * had no way of being asked, and that claim is in the marketing copy of every
 * PWA ever shipped — it is on the install card, in the app-store listing and in
 * the sales deck. The product could not verify the one promise the technology is
 * named after.
 *
 * ── THE REAL PWA BUG IS NOT "IT WORKS OFFLINE" ──────────────────────────────
 *
 * A naive offline test asserts that a navigation succeeds with the network down.
 * That is the easy half, and on its own it is close to worthless: the dangerous
 * failure is a service worker serving a CORRECT-LOOKING, STALE response.
 *
 *   A cache-first worker serves last week's price list. The page renders, the
 *   navigation succeeds, every assertion about "did it work offline" passes, and
 *   the customer is quoted a price that expired on Tuesday.
 *
 * So {@link CACHE_FIRST} does not ask "was something served". It takes the live
 * body with the network UP, takes the cached body with the network DOWN, and
 * compares them. A difference is a STALE CACHE and it is reported as the finding
 * it is. See {@link checkCacheFirst}, which is the assertion this file exists
 * for.
 *
 * ── NOT_APPLICABLE IS NEITHER A FAILURE NOR A PASS ──────────────────────────
 *
 * Most applications have no service worker. That is not a defect — it is a
 * design choice, and the overwhelming majority of good web applications make it.
 * So an application with no worker is {@link CheckVerdict} `NOT_APPLICABLE`:
 *
 *   · Reporting it as a FAILURE would file a bug against every customer who
 *     chose not to build a PWA, which is most of them.
 *   · Reporting it as a PASS would put "offline navigation works" in a report
 *     about an application that has no offline support whatsoever. That is the
 *     worst of the two by a distance, and it is the one a naive implementation
 *     produces, because "the page rendered" is true of a warm in-memory document
 *     whether a worker exists or not.
 *
 * It is also deliberately NOT `UNAVAILABLE`: a missing capability is OUR gap and
 * sends a reader to install something; a missing service worker is a FACT about
 * the application and there is nothing to install. Four verdicts, and each of
 * the four goes to a different person.
 *
 * ── OFFLINE IS DRIVEN THROUGH THE ENVIRONMENT BLOCK ─────────────────────────
 *
 * Not through a bare CDP call. `BrowserEnvironment` in
 * packages/shared/src/browser-matrix.ts carries `offline` and a named
 * `network: 'OFFLINE'` profile, the schema refuses the contradiction between
 * them, and {@link offlineEnvironment} is the one function in this file that
 * produces the block. A plugin reaching for `Network.emulateNetworkConditions`
 * directly would be a second mechanism for a thing the keystone gave one
 * vocabulary — and the half of a spec that said `offline` would be ignored.
 *
 * ── INJECTED SURFACES (rule 8) ──────────────────────────────────────────────
 *
 * There is no browser and no service worker in a test here. The worker registry,
 * the navigation, the fetch, the cache, the sync queue, the install prompt and
 * the connectivity switch are one narrow interface, {@link PwaBrowserSurface},
 * and the whole decision table is tested against a recorder that models a real
 * worker's behaviour — including the stale one.
 */

import { z } from 'zod';
import type { ExecutableTest, RunContext, StepResult, TestExecution } from '@qaai/shared';
import { browserEnvironmentSchema, pwaTestSpecSchema } from '@qaai/shared';
import { errorText } from '../files.js';
import type { UnassertedReasonValue } from '../files.js';

export type PwaTestSpec = z.infer<typeof pwaTestSpecSchema>;
export type PwaCheckName = PwaTestSpec['checks'][number];
/** The environment block, derived from the schema the keystone put on the barrel. */
export type BrowserEnvironmentValue = z.infer<typeof browserEnvironmentSchema>;

// ─── Verdicts ───────────────────────────────────────────────────────────────

/**
 * What one PWA check concluded. FOUR values, and each goes to a different person.
 *
 * MET / UNMET      claims about the application.
 * NOT_APPLICABLE   a FACT about the application: it has no service worker, so
 *                  there is nothing here to be right or wrong. Nobody acts on it.
 * UNAVAILABLE      a claim about US: the engine, the adapter or the transport
 *                  cannot do this. A Dockerfile line or a roadmap item.
 *
 * Collapsing the last two is the mistake this union exists to prevent. They look
 * identical in a count and have opposite remedies — one is "install something",
 * the other is "there is nothing to install".
 */
export const PWA_VERDICTS = ['MET', 'UNMET', 'NOT_APPLICABLE', 'UNAVAILABLE'] as const;
export type CheckVerdict = (typeof PWA_VERDICTS)[number];

export const PWA_VERDICT_PRESENT: Record<CheckVerdict, true> = {
  MET: true,
  UNMET: true,
  NOT_APPLICABLE: true,
  UNAVAILABLE: true,
};

export const PWA_VERDICT_LIST = Object.keys(PWA_VERDICT_PRESENT) as ReadonlyArray<CheckVerdict>;

export const PWA_CHECK_LABELS: Record<PwaCheckName, string> = {
  SERVICE_WORKER_ACTIVATES: 'A service worker reaches activated',
  MANIFEST_VALID: 'The manifest names what an install needs',
  OFFLINE_NAVIGATION: 'A navigation succeeds with the network down',
  CACHE_FIRST: 'The cached response is served AND is the right version',
  BACKGROUND_SYNC_REPLAY: 'A write made offline replays when connectivity returns',
  INSTALL_PROMPT_AVAILABLE: 'The in-page install affordance is offered',
  UPDATE_TAKES_OVER: 'A new worker takes over without serving a stale shell',
};

export interface PwaCheckResult {
  readonly check: PwaCheckName;
  readonly verdict: CheckVerdict;
  /** Printable verbatim. On the two non-claims it says why nothing was claimed. */
  readonly detail: string;
  /** Required exactly when the verdict is UNAVAILABLE, and null otherwise. */
  readonly reason: UnassertedReasonValue | null;
}

function metResult(check: PwaCheckName, detail: string): PwaCheckResult {
  return { check, verdict: 'MET', detail, reason: null };
}

function unmetResult(check: PwaCheckName, detail: string): PwaCheckResult {
  return { check, verdict: 'UNMET', detail, reason: null };
}

function notApplicable(check: PwaCheckName, detail: string): PwaCheckResult {
  return { check, verdict: 'NOT_APPLICABLE', detail, reason: null };
}

/** UNAVAILABLE, with the reason required by the signature rather than optional. */
function unavailable(
  check: PwaCheckName,
  detail: string,
  reason: UnassertedReasonValue,
): PwaCheckResult {
  return { check, verdict: 'UNAVAILABLE', detail, reason };
}

/**
 * The sentence an application with no service worker is reported with.
 *
 * One function so that all five worker-dependent checks say the same thing, and
 * so that a reader meeting it in a report meets it once. It states plainly that
 * this is not a defect, because a row that merely says NOT_APPLICABLE will be
 * read as a failure by somebody.
 */
export function noWorkerWhy(check: PwaCheckName, path: string): string {
  return (
    `"${path}" registers no service worker, so ${PWA_CHECK_LABELS[check]} does not apply. This ` +
    'is NOT a defect and NOT a pass: an application without a worker has no offline behaviour to ' +
    'be right or wrong about, and recording it as passing would put "offline navigation works" ' +
    'in a report about an application that has no offline support at all.'
  );
}

// ─── The injected browser surface ───────────────────────────────────────────

/** A service worker registration, as the browser reports it. */
export interface WorkerRegistration {
  /** The scope the worker claims. */
  readonly scope: string;
  readonly state: 'installing' | 'installed' | 'activating' | 'activated' | 'redundant';
  /** The script URL, for the failure message. Never credential-bearing. */
  readonly scriptUrl: string;
}

/** A web app manifest, after the adapter parsed it. */
export interface ManifestReport {
  /** Fields present and non-empty, in the manifest's own spelling. */
  readonly fields: Readonly<Record<string, boolean>>;
  /** Icon sizes declared, as `WxH` strings. */
  readonly iconSizes: readonly string[];
}

/** One navigation's outcome. */
export interface NavigationResult {
  readonly ok: boolean;
  /** The HTTP status, or `null` when the navigation never produced one. */
  readonly status: number | null;
  /** Did a service worker serve this, as opposed to the network? */
  readonly servedByWorker: boolean;
}

/** A body fetched from a path, with where it came from. */
export interface FetchedBody {
  /** The body as text. `null` means it could not be read. */
  readonly text: string | null;
  readonly servedByWorker: boolean;
  readonly status: number | null;
}

/** A queued write, for the background-sync assertion. */
export interface SyncQueueState {
  /** How many writes are waiting to be replayed. */
  readonly pending: number;
  /**
   * How many the server has received. A COUNT and not a boolean, because the
   * failure worth catching is a replay that fires TWICE and bills twice — the
   * same argument `JobEffectProbe` in ./jobs.ts makes for its own count.
   */
  readonly delivered: number;
}

/**
 * The browser, as this plugin needs it.
 *
 * Nine methods, every one of them a thing a Playwright context can genuinely do
 * against Chromium, and not a `Page` among them. `null` throughout means THE
 * ADAPTER COULD NOT ANSWER — never "no" and never zero.
 */
export interface PwaBrowserSurface {
  /** Navigate to `path` and wait for a worker to settle. */
  visit(path: string): Promise<NavigationResult>;
  /**
   * The worker registration for the current page, or `null` when the
   * application registers none.
   *
   * `null` IS the NOT_APPLICABLE signal, and it is the one place in this
   * interface where null is a fact about the application rather than about us.
   * It is distinguishable from an adapter failure because an adapter failure
   * THROWS.
   */
  registration(): Promise<WorkerRegistration | null>;
  /** The parsed manifest, or `null` when the page links none. */
  manifest(): Promise<ManifestReport | null>;
  /**
   * Apply an environment block — which is how offline is entered and left.
   *
   * Takes the keystone's `BrowserEnvironment` rather than a boolean, so that the
   * `offline` switch and the `network: 'OFFLINE'` profile are applied together
   * and a spec that set one cannot be silently half-honoured.
   */
  applyEnvironment(environment: BrowserEnvironmentValue): Promise<void>;
  /** Fetch a path from inside the page, so the worker gets a chance to serve it. */
  fetchBody(path: string): Promise<FetchedBody>;
  /** Make a write the application would queue for background sync. */
  enqueueWrite(path: string): Promise<void>;
  /** The sync queue's state, or `null` when the adapter cannot see it. */
  syncQueue(): Promise<SyncQueueState | null>;
  /**
   * Was an in-page install affordance offered?
   *
   * `null` when the adapter cannot tell. The OS-level prompt is chrome OUTSIDE
   * the page and is not observable from here at all — the PWA declaration in
   * packages/shared/src/test-type-decl.ts already records that as
   * `CAPABILITY_ABSENT`, and this method is about the page's own button.
   */
  installPromptOffered(): Promise<boolean | null>;
  /** Trigger a worker update and report the registration after it. */
  updateWorker(): Promise<WorkerRegistration | null>;
}

export interface PwaDeps {
  browser: PwaBrowserSurface;
}

// ─── The environment blocks ─────────────────────────────────────────────────

/**
 * The environment block that takes the network down.
 *
 * BOTH `offline` AND `network: 'OFFLINE'`, together, which is the whole reason
 * this is a function rather than an object literal at each call site.
 * `NETWORK_PROFILES` in packages/shared/src/browser-matrix.ts says it plainly:
 * Playwright's offline mode and a zero-bandwidth throttling profile are
 * DIFFERENT MECHANISMS with different failure modes, and a spec that set one and
 * not the other was silently half-throttled. A worker can still be served by the
 * HTTP cache under one of them and not the other, so an offline test that set
 * only `offline` would pass on a page that is not actually offline.
 */
export function offlineEnvironment(base: BrowserEnvironmentValue | undefined): BrowserEnvironmentValue {
  return { ...(base ?? {}), offline: true, network: 'OFFLINE' };
}

/**
 * The block that puts the network back.
 *
 * `NO_THROTTLING` is a real instruction and not an absence — `UNTHROTTLED_PROFILES`
 * in browser-matrix.ts makes exactly that distinction. Returning the spec's own
 * block unchanged would leave the OFFLINE profile in place if the spec carried
 * one, so connectivity would never actually return and `BACKGROUND_SYNC_REPLAY`
 * would report the customer's working sync as broken.
 */
export function onlineEnvironment(base: BrowserEnvironmentValue | undefined): BrowserEnvironmentValue {
  return { ...(base ?? {}), offline: false, network: 'NO_THROTTLING' };
}

// ─── The checks ─────────────────────────────────────────────────────────────

/** Fields a manifest must carry for an install to be offered at all. */
export const REQUIRED_MANIFEST_FIELDS: readonly string[] = [
  'name',
  'start_url',
  'display',
  'icons',
];

export async function checkServiceWorker(
  registration: WorkerRegistration | null,
  spec: PwaTestSpec,
): Promise<PwaCheckResult> {
  if (registration === null) {
    return notApplicable(
      'SERVICE_WORKER_ACTIVATES',
      noWorkerWhy('SERVICE_WORKER_ACTIVATES', spec.path),
    );
  }
  if (registration.state !== 'activated') {
    return unmetResult(
      'SERVICE_WORKER_ACTIVATES',
      `the worker at ${registration.scriptUrl} is "${registration.state}" and never reached ` +
        '"activated", so nothing it was going to cache or intercept is in effect',
    );
  }
  if (spec.expectScope !== undefined && registration.scope !== spec.expectScope) {
    return unmetResult(
      'SERVICE_WORKER_ACTIVATES',
      `the worker activated with scope "${registration.scope}" and the spec expects ` +
        `"${spec.expectScope}". A worker scoped above or below the paths it is meant to serve ` +
        'intercepts nothing, which looks identical to working until the network goes down',
    );
  }
  return metResult(
    'SERVICE_WORKER_ACTIVATES',
    `activated with scope "${registration.scope}"`,
  );
}

export async function checkManifest(
  manifest: ManifestReport | null,
): Promise<PwaCheckResult> {
  if (manifest === null) {
    return unmetResult(
      'MANIFEST_VALID',
      'the page links no web app manifest, so it cannot be installed. Unlike a missing service ' +
        'worker, this IS a defect when the check was asked for: a spec naming MANIFEST_VALID is ' +
        'an application claiming to be installable',
    );
  }
  const missing = REQUIRED_MANIFEST_FIELDS.filter((field) => manifest.fields[field] !== true);
  if (missing.length > 0) {
    return unmetResult(
      'MANIFEST_VALID',
      `the manifest is missing ${missing.join(', ')}. Without every one of these the browser ` +
        'will not offer an install, and it fails silently — nothing in the page says so',
    );
  }
  if (manifest.iconSizes.length === 0) {
    return unmetResult(
      'MANIFEST_VALID',
      'the manifest declares `icons` and no icon SIZES, so no browser can choose one and the ' +
        'install is not offered',
    );
  }
  return metResult('MANIFEST_VALID', `valid, with icon sizes ${manifest.iconSizes.join(', ')}`);
}

/**
 * Assert that the named paths still render with the network down.
 *
 * The spec refuses `OFFLINE_NAVIGATION` with an empty `offlinePaths` — its own
 * message says a check with no path "would assert that the page it is already on
 * still renders, which a warm in-memory document does whether a worker exists or
 * not". That refusal is upstream; this function trusts it and visits each path.
 */
export async function checkOfflineNavigation(
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
  registration: WorkerRegistration | null,
): Promise<PwaCheckResult> {
  if (registration === null) {
    return notApplicable('OFFLINE_NAVIGATION', noWorkerWhy('OFFLINE_NAVIGATION', spec.path));
  }

  /*
   * TAKE THE NETWORK DOWN FIRST, and this line is a bug this file's own tests
   * caught. `runPwaTest` applies the ONLINE environment before any check runs —
   * it has to, because the first navigation and the registration lookup need the
   * network. Without this call the check visited every path with the network UP
   * and asserted "the service worker served it", which is the wrong question
   * entirely: it fails a correct application whose worker sensibly defers to the
   * network when there is one, and it proves nothing about offline either way.
   *
   * Each check that needs a particular connectivity state establishes it itself,
   * exactly as `checkCacheFirst` and `checkBackgroundSync` do. Relying on the
   * order checks happen to run in is how one of them comes to depend on another
   * one's leftovers.
   */
  await browser.applyEnvironment(offlineEnvironment(spec.environment));

  const failures: string[] = [];
  const servedByNetwork: string[] = [];
  for (const path of spec.offlinePaths) {
    const result = await browser.visit(path);
    if (!result.ok) {
      failures.push(`${path} (status ${result.status ?? 'none'})`);
      continue;
    }
    if (!result.servedByWorker) {
      /*
       * IT RENDERED AND THE WORKER DID NOT SERVE IT. This is the subtle pass
       * that must not be one: with the network emulated down, a document can
       * still come out of the HTTP cache or an in-memory entry, so "the page
       * rendered" is true of an application with no offline support at all.
       * Asserting the worker SERVED it is what makes the check mean anything.
       */
      servedByNetwork.push(path);
    }
  }

  if (failures.length > 0) {
    return unmetResult(
      'OFFLINE_NAVIGATION',
      `${failures.length} of ${spec.offlinePaths.length} path(s) did not render with the network ` +
        `down: ${failures.join(', ')}`,
    );
  }
  if (servedByNetwork.length > 0) {
    return unmetResult(
      'OFFLINE_NAVIGATION',
      `${servedByNetwork.length} path(s) rendered offline WITHOUT the service worker serving ` +
        `them: ${servedByNetwork.join(', ')}. A warm HTTP-cache entry renders whether a worker ` +
        'exists or not, so this is not evidence of offline support — it is the pass that means ' +
        '"we did not check"',
    );
  }
  return metResult(
    'OFFLINE_NAVIGATION',
    `all ${spec.offlinePaths.length} path(s) were served by the worker with the network down`,
  );
}

/**
 * CACHE-FIRST, AND WHETHER THE CACHED THING IS THE RIGHT VERSION.
 *
 * THE ASSERTION THIS FILE EXISTS FOR. A cache-first worker serving last week's
 * price list is the real PWA bug: the page renders, the navigation succeeds, and
 * the customer is quoted a price that expired on Tuesday. Every check that asks
 * only "was something served" passes on it.
 *
 * So: take the live body with the network UP, take the cached body with the
 * network DOWN, and compare. Three outcomes and all three matter.
 *
 *   · The worker did not serve it at all     → UNMET, cache-first is not in effect
 *   · The worker served a DIFFERENT body     → UNMET, the cache is STALE
 *   · The worker served the same body        → MET
 *
 * A body that could not be read in either direction is UNAVAILABLE and never a
 * pass: comparing `null` with `null` and calling it a match is how a cache check
 * comes to pass on a page it never loaded.
 */
export async function checkCacheFirst(
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
  registration: WorkerRegistration | null,
): Promise<PwaCheckResult> {
  if (registration === null) {
    return notApplicable('CACHE_FIRST', noWorkerWhy('CACHE_FIRST', spec.path));
  }

  // The path to compare: the first offline path when one is named, else the
  // spec's own. Not a third source of truth; just the most specific available.
  const path = spec.offlinePaths[0] ?? spec.path;

  await browser.applyEnvironment(onlineEnvironment(spec.environment));
  const live = await browser.fetchBody(path);
  await browser.applyEnvironment(offlineEnvironment(spec.environment));
  const cached = await browser.fetchBody(path);

  if (live.text === null || cached.text === null) {
    return unavailable(
      'CACHE_FIRST',
      `the ${live.text === null ? 'live' : 'cached'} body of "${path}" could not be read, so the ` +
        'cached version was NOT compared against the live one. Two unreadable bodies are not a ' +
        'match',
      'CAPABILITY_ABSENT',
    );
  }

  if (!cached.servedByWorker) {
    return unmetResult(
      'CACHE_FIRST',
      `"${path}" was not served by the service worker with the network down (status ` +
        `${cached.status ?? 'none'}), so cache-first behaviour is not in effect for it`,
    );
  }

  if (cached.text !== live.text) {
    return unmetResult(
      'CACHE_FIRST',
      `the worker served a CACHED version of "${path}" that differs from the live one — a STALE ` +
        `CACHE (${cached.text.length} bytes cached against ${live.text.length} live). This is the ` +
        'real PWA bug: the page renders, the navigation succeeds, and the customer reads last ' +
        "week's prices. The bodies are not quoted here — they are the customer's content",
    );
  }

  return metResult(
    'CACHE_FIRST',
    `the worker served "${path}" offline and the cached body matches the live one`,
  );
}

/**
 * A write made offline must replay once connectivity returns — exactly once.
 *
 * `delivered` is a COUNT, so a replay that fires twice is caught. A sync that
 * bills twice is the same defect class `EXACTLY_ONCE` catches in ./jobs.ts, and
 * it is worse here because the user saw one button press.
 *
 * NOTE: this drives the application's OWN sync queue through the page. The PWA
 * declaration records "a background sync replaying after the device genuinely
 * regains connectivity" as `CAPABILITY_ABSENT`, and that stays true — a real
 * radio coming back is not something an emulated context reproduces. What this
 * asserts is the queue-and-flush logic, which is where the bugs are.
 */
export async function checkBackgroundSync(
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
  registration: WorkerRegistration | null,
): Promise<PwaCheckResult> {
  if (registration === null) {
    return notApplicable(
      'BACKGROUND_SYNC_REPLAY',
      noWorkerWhy('BACKGROUND_SYNC_REPLAY', spec.path),
    );
  }

  await browser.applyEnvironment(offlineEnvironment(spec.environment));
  await browser.enqueueWrite(spec.path);

  const queued = await browser.syncQueue();
  if (queued === null) {
    return unavailable(
      'BACKGROUND_SYNC_REPLAY',
      'this adapter cannot see the application\'s sync queue, so nothing about the replay is ' +
        'asserted. The write was made offline and its fate is unknown',
      'CAPABILITY_ABSENT',
    );
  }
  if (queued.pending === 0 && queued.delivered === 0) {
    return unmetResult(
      'BACKGROUND_SYNC_REPLAY',
      'the write made with the network down was neither queued nor delivered, so it was LOST. ' +
        'A write that vanishes offline is indistinguishable, to the person who made it, from one ' +
        'that succeeded',
    );
  }

  await browser.applyEnvironment(onlineEnvironment(spec.environment));
  const flushed = await browser.syncQueue();
  if (flushed === null) {
    return unavailable(
      'BACKGROUND_SYNC_REPLAY',
      'the sync queue could not be read after connectivity returned, so the replay was not ' +
        'asserted',
      'CAPABILITY_ABSENT',
    );
  }

  if (flushed.delivered === 0) {
    return unmetResult(
      'BACKGROUND_SYNC_REPLAY',
      `connectivity returned and the queued write was not replayed — ${flushed.pending} still ` +
        'pending, 0 delivered',
    );
  }
  if (flushed.delivered > 1) {
    return unmetResult(
      'BACKGROUND_SYNC_REPLAY',
      `the queued write was replayed ${flushed.delivered} times. The user pressed the button ` +
        'once; a duplicated replay sends two emails and bills two charges',
    );
  }
  if (flushed.pending > 0) {
    return unmetResult(
      'BACKGROUND_SYNC_REPLAY',
      `one write was delivered and ${flushed.pending} remain pending after connectivity ` +
        'returned, so the queue is not draining',
    );
  }
  return metResult(
    'BACKGROUND_SYNC_REPLAY',
    'the write made offline replayed exactly once when connectivity returned',
  );
}

export async function checkInstallPrompt(
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
): Promise<PwaCheckResult> {
  const offered = await browser.installPromptOffered();
  if (offered === null) {
    return unavailable(
      'INSTALL_PROMPT_AVAILABLE',
      'this adapter cannot tell whether an in-page install affordance was offered. The OS-level ' +
        'prompt is chrome outside the page and is not observable from a browser context at all',
      'CAPABILITY_ABSENT',
    );
  }
  return offered
    ? metResult('INSTALL_PROMPT_AVAILABLE', 'an in-page install affordance was offered')
    : unmetResult(
        'INSTALL_PROMPT_AVAILABLE',
        `no in-page install affordance appeared on "${spec.path}". The browser fires ` +
          '`beforeinstallprompt` and an application that never handles it offers the user no way ' +
          'to install, however complete its manifest is',
      );
}

/**
 * A new worker must take over, and must not leave a stale shell being served.
 *
 * The `skipWaiting`/`clients.claim()` bug: a deployed update installs, waits for
 * every tab to close, and until then every user is served the previous build.
 * Reported as UNMET when the new worker does not reach `activated`.
 */
export async function checkUpdateTakesOver(
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
  registration: WorkerRegistration | null,
): Promise<PwaCheckResult> {
  if (registration === null) {
    return notApplicable('UPDATE_TAKES_OVER', noWorkerWhy('UPDATE_TAKES_OVER', spec.path));
  }
  const after = await browser.updateWorker();
  if (after === null) {
    return unavailable(
      'UPDATE_TAKES_OVER',
      'the worker registration could not be read after an update was triggered, so the takeover ' +
        'was not asserted',
      'CAPABILITY_ABSENT',
    );
  }
  if (after.state !== 'activated') {
    return unmetResult(
      'UPDATE_TAKES_OVER',
      `after an update the worker is "${after.state}" rather than "activated", so the previous ` +
        'build is still serving every open tab. A deployed fix that nobody receives until they ' +
        'close every tab is a fix that did not ship',
    );
  }
  return metResult('UPDATE_TAKES_OVER', 'the updated worker activated and took over');
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Run one check.
 *
 * An exhaustive switch over the spec's own union, so the compiler refuses a new
 * `PWA_CHECKS` member with no branch — the failure mode `JOB_ASSERTION_PRESENCE`
 * in ./jobs.ts names: a zod enum accepting a value no branch honours, which
 * `check:wiring` cannot see.
 */
export async function runCheck(
  check: PwaCheckName,
  spec: PwaTestSpec,
  browser: PwaBrowserSurface,
  registration: WorkerRegistration | null,
): Promise<PwaCheckResult> {
  switch (check) {
    case 'SERVICE_WORKER_ACTIVATES':
      return checkServiceWorker(registration, spec);
    case 'MANIFEST_VALID':
      return checkManifest(await browser.manifest());
    case 'OFFLINE_NAVIGATION':
      return checkOfflineNavigation(spec, browser, registration);
    case 'CACHE_FIRST':
      return checkCacheFirst(spec, browser, registration);
    case 'BACKGROUND_SYNC_REPLAY':
      return checkBackgroundSync(spec, browser, registration);
    case 'INSTALL_PROMPT_AVAILABLE':
      return checkInstallPrompt(spec, browser);
    case 'UPDATE_TAKES_OVER':
      return checkUpdateTakesOver(spec, browser, registration);
  }
}

// ─── The execution ──────────────────────────────────────────────────────────

function toStep(result: PwaCheckResult, index: number, startedAt: number): StepResult {
  const label = PWA_CHECK_LABELS[result.check];
  const status: StepResult['status'] =
    result.verdict === 'MET' ? 'PASSED' : result.verdict === 'UNMET' ? 'FAILED' : 'SKIPPED';
  const title =
    result.verdict === 'MET'
      ? `${label} — ${result.detail}`
      : `${label} — ${result.verdict}${
          result.reason !== null ? ` (${result.reason})` : ''
        }: ${result.detail}`;
  return {
    index,
    title,
    status,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error:
      result.verdict === 'UNMET'
        ? { message: result.detail, stack: null, selector: null, expected: null, actual: null }
        : null,
  };
}

/**
 * Run a PWA test.
 *
 * ── FOUR OUTCOMES, AND THE NOT_APPLICABLE ONE IS THE INTERESTING ONE ────────
 *
 * FAILED   something was UNMET. A statement about the application.
 * SKIPPED, notRun UNSUPPORTED
 *          every check was NOT_APPLICABLE — the application has no service
 *          worker. UNSUPPORTED rather than NOT_RUN because it is a definite fact
 *          about the subject rather than an absence of evidence, and
 *          `NOT_RUN_KINDS` in packages/shared/src/constants.ts says UNSUPPORTED
 *          and BLOCKED_BY_ENV must be EXCLUDED from a pass rate and from a
 *          coverage denominator. That is exactly right here: an application with
 *          no PWA must not be counted as having untested PWA surface.
 * SKIPPED, notRun NOT_RUN
 *          nothing was established and it was not for want of a worker — the
 *          adapter could not answer. The weakest honest reading.
 * PASSED   something was proved and nothing disproved, with every
 *          NOT_APPLICABLE and UNAVAILABLE disclosed in `errorMessage`.
 */
export async function runPwaTest(
  ctx: RunContext,
  test: ExecutableTest,
  spec: PwaTestSpec,
  deps: PwaDeps,
): Promise<TestExecution> {
  const startedAt = Date.now();
  const steps: StepResult[] = [];
  const results: PwaCheckResult[] = [];
  const base = {
    testId: test.id,
    network: [],
    console: [],
    videoKey: null,
    traceKey: null,
    retriedAndPassed: false,
    findings: [],
  };

  /*
   * The first navigation and the registration lookup happen ONCE, with the
   * network UP, before any check runs. Both because every worker-dependent
   * check needs the answer, and because asking per check would register the
   * worker repeatedly and make `UPDATE_TAKES_OVER` assert against a worker that
   * a previous check had already replaced.
   */
  let registration: WorkerRegistration | null;
  try {
    await deps.browser.applyEnvironment(onlineEnvironment(spec.environment));
    await deps.browser.visit(spec.path);
    registration = await deps.browser.registration();
  } catch (err) {
    const why =
      `"${spec.path}" could not be loaded or its service-worker registration could not be read: ` +
      `${errorText(err)}. Nothing about this application's offline behaviour is asserted`;
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      notRun: { kind: 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  for (const check of spec.checks) {
    if (ctx.signal.aborted) break;
    const stepStartedAt = Date.now();
    let result: PwaCheckResult;
    try {
      result = await runCheck(check, spec, deps.browser, registration);
    } catch (err) {
      // An adapter that threw told us nothing about the application.
      result = unavailable(
        check,
        `the browser adapter failed while checking this: ${errorText(err)}`,
        'CAPABILITY_ABSENT',
      );
    }
    results.push(result);
    const step = toStep(result, steps.length, stepStartedAt);
    ctx.logger.step({ testId: test.id, index: step.index, title: step.title, status: step.status });
    steps.push(step);
  }

  if (ctx.signal.aborted) {
    const why = 'the run was cancelled before every check ran';
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      notRun: { kind: 'CANCELLED', why },
      errorMessage: why,
    };
  }

  const unmet = results.filter((r) => r.verdict === 'UNMET');
  const proved = results.filter((r) => r.verdict === 'MET');
  const inapplicable = results.filter((r) => r.verdict === 'NOT_APPLICABLE');
  const unmeasured = results.filter((r) => r.verdict === 'UNAVAILABLE');

  /*
   * The disclosure keeps NOT_APPLICABLE and UNAVAILABLE in SEPARATE clauses.
   * Merging them would send a reader to install a PDF parser because their
   * application has no service worker — the two halves go to different people,
   * exactly as `OUR_UNASSERTED_REASONS` in test-type-decl.ts splits our gaps
   * from the environment's.
   */
  const clauses: string[] = [];
  if (inapplicable.length > 0) {
    clauses.push(
      `${inapplicable.length} of ${results.length} check(s) DO NOT APPLY (no service worker): ` +
        inapplicable.map((r) => r.check).join(', '),
    );
  }
  if (unmeasured.length > 0) {
    /*
     * The DETAIL travels with the reason, not just the check name. A clause
     * reading "MANIFEST_VALID (CAPABILITY_ABSENT)" tells a reader which check
     * went unmeasured and nothing they can act on — the adapter's own sentence
     * ("the manifest fetch failed with …") is the part that says what to fix.
     * Rule 12 wants a count AND a reason, and a reason nobody can act on is
     * half of one.
     */
    clauses.push(
      `${unmeasured.length} of ${results.length} check(s) were NOT MEASURED: ` +
        unmeasured.map((r) => `${r.check} (${r.reason}): ${r.detail}`).join(' | '),
    );
  }
  const disclosure = clauses.join(' ── ');

  if (unmet.length > 0) {
    return {
      ...base,
      status: 'FAILED',
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage: [unmet.map((r) => r.detail).join(' | '), disclosure]
        .filter((s) => s.length > 0)
        .join(' ── '),
    };
  }

  if (proved.length === 0) {
    /*
     * Nothing was established. WHICH of the two SKIPPED kinds depends on
     * whether the application has a worker at all, and the distinction is the
     * honesty point of this whole plugin: UNSUPPORTED is excluded from the
     * coverage denominator, so an application with no PWA is not reported as
     * having untested PWA surface for ever.
     */
    const everyCheckInapplicable = inapplicable.length === results.length && results.length > 0;
    const why = everyCheckInapplicable
      ? `"${spec.path}" registers no service worker, so none of this test's ${results.length} ` +
        'check(s) applies. This is NOT a defect and NOT a pass: the application has no offline ' +
        'behaviour to be right or wrong about. Nothing is counted either way.'
      : `None of this test's ${results.length} check(s) could be measured, so nothing is claimed ` +
        `about "${spec.path}". ${disclosure}`;
    return {
      ...base,
      status: 'SKIPPED',
      durationMs: Date.now() - startedAt,
      steps,
      notRun: { kind: everyCheckInapplicable ? 'UNSUPPORTED' : 'NOT_RUN', why },
      errorMessage: why,
    };
  }

  return {
    ...base,
    status: 'PASSED',
    durationMs: Date.now() - startedAt,
    steps,
    errorMessage: disclosure.length > 0 ? disclosure : null,
  };
}

// ─── The shipped adapter ────────────────────────────────────────────────────

/**
 * The browser surface this product ships with: none.
 *
 * Every method REJECTS except the three whose `null` is a meaningful answer, and
 * the split is deliberate. A surface that resolved `registration()` to `null`
 * would make every check report NOT_APPLICABLE — "your application has no service
 * worker" — about an application nobody looked at. That is a fabricated fact
 * about the customer's code, which is worse than an error, so `registration`
 * throws and the execution reports NOT_RUN.
 */
export const unavailablePwaBrowser: PwaBrowserSurface = {
  visit() {
    return Promise.reject(
      new Error(
        'No browser context is configured for this run. QAAI can assert that a service worker ' +
          'activates, that a navigation succeeds offline, that the cached response is the RIGHT ' +
          'version, that a queued write replays exactly once and that an install is offered — ' +
          'but it needs a Chromium context to do it. Nothing was measured.',
      ),
    );
  },
  registration() {
    /*
     * REJECTS rather than resolving null. See this adapter's note: a null here
     * is the NOT_APPLICABLE signal, and producing it with no browser would
     * report "this application has no service worker" about an application that
     * was never loaded.
     */
    return Promise.reject(new Error('No browser context is configured for this run.'));
  },
  manifest() {
    return Promise.reject(new Error('No browser context is configured for this run.'));
  },
  applyEnvironment() {
    return Promise.reject(new Error('No browser context is configured for this run.'));
  },
  fetchBody() {
    return Promise.reject(new Error('No browser context is configured for this run.'));
  },
  enqueueWrite() {
    return Promise.reject(new Error('No browser context is configured for this run.'));
  },
  syncQueue() {
    // Null is honest here: "cannot see the queue" is exactly what this is, and
    // the check reports UNAVAILABLE with a reason.
    return Promise.resolve(null);
  },
  installPromptOffered() {
    return Promise.resolve(null);
  },
  updateWorker() {
    return Promise.resolve(null);
  },
};

let deps: PwaDeps = { browser: unavailablePwaBrowser };

/** Install the browser surface a run executes against. Returns the previous set. */
export function setPwaDeps(next: PwaDeps): PwaDeps {
  const previous = deps;
  deps = next;
  return previous;
}

export const pwaPlugin = {
  type: 'PWA' as const,

  validate(test: ExecutableTest): void {
    const parsed = pwaTestSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`PWA test "${test.name}" has an invalid spec — ${issues}`);
    }

    /*
     * Caught before anything is driven, for the same reason ./jobs.ts catches
     * its two policy gaps in `validate`: a test author who learns about this
     * from an UNAVAILABLE row has waited for a run to be told about a spec they
     * could have fixed in a second.
     *
     * CACHE_FIRST compares the live body against the cached one, and it needs a
     * path whose content is stable enough to compare. The spec's `path` defaults
     * to `/`, and a root route is very often the one page that differs on every
     * load — a session greeting, a CSRF token, a timestamp — so comparing it
     * would report a STALE CACHE on a correct application every single time. A
     * false stale-cache finding is expensive: it sends somebody to audit a
     * caching layer that is working.
     */
    const spec = parsed.data;
    if (spec.checks.includes('CACHE_FIRST') && spec.offlinePaths.length === 0) {
      throw new Error(
        `PWA test "${test.name}" requests CACHE_FIRST and names no path in \`offlinePaths\`, so ` +
          `it would compare the live and cached bodies of "${spec.path}". Name an asset or a ` +
          'route whose content is stable between two loads: a page with a session greeting, a ' +
          'CSRF token or a timestamp in it differs on every request, so the check would report a ' +
          'STALE CACHE against a perfectly correct application.',
      );
    }
  },

  execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    return runPwaTest(ctx, test, pwaTestSpecSchema.parse(test.spec), deps);
  },
};
