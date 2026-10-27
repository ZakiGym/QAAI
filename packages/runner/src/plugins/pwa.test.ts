/**
 * Tests for the PWA test type.
 *
 * The recorder at the top of this file models a real service worker, including
 * the two behaviours this plugin exists to catch: a worker serving a STALE
 * cached body, and a page that renders offline without the worker serving it.
 *
 * No browser, no service worker, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExecutableTest, RunContext, TestExecution } from '@qaai/shared';
import { PWA_CHECKS, pwaTestSpecSchema } from '@qaai/shared';
import {
  PWA_CHECK_LABELS,
  PWA_VERDICTS,
  PWA_VERDICT_LIST,
  REQUIRED_MANIFEST_FIELDS,
  checkBackgroundSync,
  checkCacheFirst,
  checkOfflineNavigation,
  noWorkerWhy,
  offlineEnvironment,
  onlineEnvironment,
  pwaPlugin,
  runCheck,
  runPwaTest,
  setPwaDeps,
  unavailablePwaBrowser,
} from './pwa.js';
import type {
  BrowserEnvironmentValue,
  ManifestReport,
  PwaBrowserSurface,
  PwaDeps,
  SyncQueueState,
  WorkerRegistration,
} from './pwa.js';

// ─── The recorder ────────────────────────────────────────────────────────────

const ACTIVATED: WorkerRegistration = {
  scope: '/',
  state: 'activated',
  scriptUrl: 'https://app.example.test/sw.js',
};

const GOOD_MANIFEST: ManifestReport = {
  fields: { name: true, start_url: true, display: true, icons: true },
  iconSizes: ['192x192', '512x512'],
};

/**
 * A browser that models a worker.
 *
 * `cachedBody` defaults to the live body — a correct cache. Setting it to
 * something else models the stale cache this plugin is built to catch, which is
 * the point of modelling the worker at all rather than returning canned verdicts.
 */
function recorder(
  options: {
    registration?: WorkerRegistration | null;
    manifest?: ManifestReport | null;
    liveBody?: string;
    cachedBody?: string;
    servedByWorkerOffline?: boolean;
    offlineVisitOk?: boolean;
    offlineVisitServedByWorker?: boolean;
    queueAfterEnqueue?: SyncQueueState | null;
    queueAfterOnline?: SyncQueueState | null;
    installPrompt?: boolean | null;
    updated?: WorkerRegistration | null;
    throwOn?: 'visit' | 'registration' | 'manifest';
  } = {},
): { surface: PwaBrowserSurface; environments: BrowserEnvironmentValue[] } {
  const environments: BrowserEnvironmentValue[] = [];
  let offline = false;
  let enqueued = false;

  const surface: PwaBrowserSurface = {
    visit(path) {
      if (options.throwOn === 'visit') return Promise.reject(new Error('navigation failed'));
      if (!offline) return Promise.resolve({ ok: true, status: 200, servedByWorker: false });
      void path;
      return Promise.resolve({
        ok: options.offlineVisitOk ?? true,
        status: (options.offlineVisitOk ?? true) ? 200 : null,
        servedByWorker: options.offlineVisitServedByWorker ?? true,
      });
    },
    registration() {
      if (options.throwOn === 'registration') {
        return Promise.reject(new Error('could not read registration'));
      }
      return Promise.resolve(
        options.registration === undefined ? ACTIVATED : options.registration,
      );
    },
    manifest() {
      if (options.throwOn === 'manifest') return Promise.reject(new Error('manifest unreadable'));
      return Promise.resolve(options.manifest === undefined ? GOOD_MANIFEST : options.manifest);
    },
    applyEnvironment(environment) {
      environments.push(environment);
      offline = environment.offline === true;
      return Promise.resolve();
    },
    fetchBody() {
      const live = options.liveBody ?? 'price: 10.00';
      if (!offline) return Promise.resolve({ text: live, servedByWorker: false, status: 200 });
      return Promise.resolve({
        text: options.cachedBody ?? live,
        servedByWorker: options.servedByWorkerOffline ?? true,
        status: 200,
      });
    },
    enqueueWrite() {
      enqueued = true;
      return Promise.resolve();
    },
    syncQueue() {
      if (!enqueued) return Promise.resolve({ pending: 0, delivered: 0 });
      if (offline) {
        return Promise.resolve(
          options.queueAfterEnqueue === undefined
            ? { pending: 1, delivered: 0 }
            : options.queueAfterEnqueue,
        );
      }
      return Promise.resolve(
        options.queueAfterOnline === undefined
          ? { pending: 0, delivered: 1 }
          : options.queueAfterOnline,
      );
    },
    installPromptOffered() {
      return Promise.resolve(options.installPrompt === undefined ? true : options.installPrompt);
    },
    updateWorker() {
      return Promise.resolve(options.updated === undefined ? ACTIVATED : options.updated);
    },
  };
  return { surface, environments };
}

function deps(options: Parameters<typeof recorder>[0] = {}): PwaDeps {
  return { browser: recorder(options).surface };
}

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'https://app.example.test',
    secrets: {},
    storageState: null,
    artifacts: { put: vi.fn() } as unknown as RunContext['artifacts'],
    logger: { step: vi.fn(), log: vi.fn() } as unknown as RunContext['logger'],
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 20261026,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...overrides,
  };
}

function test(spec: unknown): ExecutableTest {
  return { id: 'test_1', name: 'offline shell', type: 'PWA', spec } as unknown as ExecutableTest;
}

function spec(overrides: Record<string, unknown> = {}): ReturnType<typeof pwaTestSpecSchema.parse> {
  return pwaTestSpecSchema.parse({
    path: '/dashboard',
    checks: ['SERVICE_WORKER_ACTIVATES'],
    ...overrides,
  });
}

function statuses(execution: TestExecution): string[] {
  return execution.steps.map((s) => s.status);
}

// ─── Vocabulary parity ───────────────────────────────────────────────────────

describe('the vocabularies carry both halves of their parity guard', () => {
  it('matches the verdict presence record at run time', () => {
    expect([...PWA_VERDICT_LIST].sort()).toEqual([...PWA_VERDICTS].sort());
  });

  it('labels every check the shared spec can name', () => {
    /*
     * Keyed off `PWA_CHECKS` from @qaai/shared rather than a local copy, so a
     * new member there with no label here is a compile error plus this failure
     * — not a check rendering as `undefined` in a report.
     */
    for (const check of PWA_CHECKS) {
      expect(PWA_CHECK_LABELS[check]).toBeTruthy();
    }
    expect(Object.keys(PWA_CHECK_LABELS).sort()).toEqual([...PWA_CHECKS].sort());
  });

  it('reaches a branch for every check, with no fallthrough', async () => {
    /*
     * The failure the other two parity tests cannot catch: a zod enum accepting
     * a value that no branch honours. Every member must come back with a real
     * verdict rather than undefined.
     */
    for (const check of PWA_CHECKS) {
      const result = await runCheck(
        check,
        spec({ checks: [check], offlinePaths: ['/dashboard'] }),
        recorder().surface,
        ACTIVATED,
      );
      expect(PWA_VERDICTS).toContain(result.verdict);
      expect(result.check).toBe(check);
    }
  });
});

// ─── NOT_APPLICABLE: the headline honesty rule ───────────────────────────────

describe('an application with no service worker is NOT_APPLICABLE, not a pass and not a failure', () => {
  it.each([
    'SERVICE_WORKER_ACTIVATES',
    'OFFLINE_NAVIGATION',
    'CACHE_FIRST',
    'BACKGROUND_SYNC_REPLAY',
    'UPDATE_TAKES_OVER',
  ] as const)('reports %s as NOT_APPLICABLE with no worker', async (check) => {
    const result = await runCheck(
      check,
      spec({ checks: [check], offlinePaths: ['/dashboard'] }),
      recorder({ registration: null }).surface,
      null,
    );
    expect(result.verdict).toBe('NOT_APPLICABLE');
    // Not UNAVAILABLE: a missing worker is a fact about the application and
    // there is nothing to install.
    expect(result.reason).toBeNull();
  });

  it('says plainly in the sentence that it is neither a defect nor a pass', () => {
    /*
     * A row that merely says NOT_APPLICABLE will be read as a failure by
     * somebody, so the sentence has to carry the meaning.
     */
    const why = noWorkerWhy('OFFLINE_NAVIGATION', '/dashboard');
    expect(why).toContain('NOT a defect');
    expect(why).toContain('NOT a pass');
    expect(why).toContain('no offline support');
  });

  it('is SKIPPED with UNSUPPORTED when every check was inapplicable', async () => {
    /*
     * UNSUPPORTED and not NOT_RUN, and this is the load-bearing choice.
     * `NOT_RUN_KINDS` in packages/shared/src/constants.ts says UNSUPPORTED must
     * be EXCLUDED from a pass rate and a coverage denominator — so an
     * application with no PWA is not reported as having untested PWA surface for
     * ever, which is what a NOT_RUN would do.
     */
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['SERVICE_WORKER_ACTIVATES', 'CACHE_FIRST'], offlinePaths: ['/a'] }),
      deps({ registration: null }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('UNSUPPORTED');
    expect(execution.notRun?.why).toContain('NOT a defect');
  });

  it('uses NOT_RUN, not UNSUPPORTED, when nothing was measured for a different reason', async () => {
    // The adapter could not see the sync queue. The application may have a
    // perfectly good worker; we simply could not look.
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      deps({ queueAfterEnqueue: null }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
  });

  it('keeps NOT_APPLICABLE and UNAVAILABLE in separate clauses of the disclosure', async () => {
    /*
     * Merging them would send a reader to install something because their
     * application has no service worker. The two halves go to different people,
     * exactly as OUR_UNASSERTED_REASONS splits our gaps from the environment's.
     */
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['MANIFEST_VALID', 'CACHE_FIRST'], offlinePaths: ['/a'] }),
      deps({ registration: null }),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('DO NOT APPLY');
    expect(execution.errorMessage).toContain('no service worker');
  });
});

// ─── The real PWA bug: a stale cache ─────────────────────────────────────────

describe('catches a cache serving the wrong version, which is the real PWA bug', () => {
  it('fails when the cached body differs from the live one', async () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. The page renders, the navigation
     * succeeds, the worker served it — and the customer is quoted last week's
     * price. Every check that asks only "was something served" passes on this.
     */
    const result = await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      recorder({ liveBody: 'price: 12.00', cachedBody: 'price: 10.00' }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('STALE');
  });

  it('passes when the cached body matches the live one', async () => {
    const result = await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      recorder({ liveBody: 'price: 12.00', cachedBody: 'price: 12.00' }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('MET');
  });

  it("never quotes the customer's content into the stale-cache failure", async () => {
    // The bodies are the customer's own page content.
    const result = await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      recorder({
        liveBody: 'Ada Lovelace, acct 0099887766',
        cachedBody: 'Ada Lovelace, acct 0011223344',
      }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).not.toContain('Ada Lovelace');
    expect(result.detail).not.toContain('0099887766');
  });

  it('fails when the worker did not serve the offline fetch at all', async () => {
    const result = await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      recorder({ servedByWorkerOffline: false }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('not served by the service worker');
  });

  it('never calls two unreadable bodies a match', async () => {
    /*
     * Comparing null with null and calling it equal is how a cache check comes
     * to pass on a page it never loaded.
     */
    const unreadable: PwaBrowserSurface = {
      ...recorder().surface,
      fetchBody: () => Promise.resolve({ text: null, servedByWorker: true, status: null }),
    };
    const result = await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      unreadable,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.reason).toBe('CAPABILITY_ABSENT');
    expect(result.detail).toContain('not a match');
  });

  it('takes the live body with the network up and the cached one with it down', async () => {
    /*
     * The ORDER, asserted. Reversed, both reads would come from the cache and
     * the comparison would always match — a check that can never fail.
     */
    const rec = recorder({ liveBody: 'live', cachedBody: 'stale' });
    await checkCacheFirst(
      spec({ checks: ['CACHE_FIRST'], offlinePaths: ['/prices'] }),
      rec.surface,
      ACTIVATED,
    );
    expect(rec.environments.map((e) => e.offline)).toEqual([false, true]);
  });
});

// ─── Offline navigation, and the pass that means nothing ─────────────────────

describe('offline navigation asserts the worker served it, not merely that it rendered', () => {
  it('passes when the worker served every named path', async () => {
    const result = await checkOfflineNavigation(
      spec({ checks: ['OFFLINE_NAVIGATION'], offlinePaths: ['/a', '/b'] }),
      recorder().surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('MET');
  });

  it('fails a path that did not render with the network down', async () => {
    const result = await checkOfflineNavigation(
      spec({ checks: ['OFFLINE_NAVIGATION'], offlinePaths: ['/a'] }),
      recorder({ offlineVisitOk: false }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('did not render');
  });

  it('takes the network down itself rather than trusting the check order', async () => {
    /*
     * A BUG THIS FILE'S OWN TESTS CAUGHT. `runPwaTest` applies the ONLINE
     * environment before any check runs — it must, because the first navigation
     * and the registration lookup need the network. So a check that did not take
     * the network down itself visited every path ONLINE and asserted "the worker
     * served it", which fails a correct application whose worker sensibly defers
     * to the network when there is one, and proves nothing about offline either
     * way.
     *
     * Asserted through the whole execution, not just the check, because that is
     * where the ordering bug lived.
     */
    const rec = recorder();
    await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['OFFLINE_NAVIGATION'], offlinePaths: ['/a'] }),
      { browser: rec.surface },
    );
    // Online for the registration lookup, then offline for the check.
    expect(rec.environments.map((e) => e.offline)).toEqual([false, true]);
  });

  it('fails a path that rendered offline WITHOUT the worker serving it', async () => {
    /*
     * The subtle pass that must not be one. With the network emulated down, a
     * document can still come out of the HTTP cache, so "the page rendered" is
     * true of an application with no offline support at all.
     */
    const result = await checkOfflineNavigation(
      spec({ checks: ['OFFLINE_NAVIGATION'], offlinePaths: ['/a'] }),
      recorder({ offlineVisitServedByWorker: false }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('we did not check');
  });
});

// ─── Background sync, exactly once ───────────────────────────────────────────

describe('a write made offline must replay exactly once', () => {
  it('passes when it is delivered once and the queue drains', async () => {
    const result = await checkBackgroundSync(
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      recorder().surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('MET');
  });

  it('fails a write that was lost rather than queued', async () => {
    // A write that vanishes offline is indistinguishable, to the person who made
    // it, from one that succeeded.
    const result = await checkBackgroundSync(
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      recorder({ queueAfterEnqueue: { pending: 0, delivered: 0 } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('LOST');
  });

  it('fails a replay that never happened', async () => {
    const result = await checkBackgroundSync(
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      recorder({ queueAfterOnline: { pending: 1, delivered: 0 } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('not replayed');
  });

  it('fails a replay that fired twice', async () => {
    /*
     * The count, not a boolean. The user pressed the button once; a duplicated
     * replay sends two emails and bills two charges.
     */
    const result = await checkBackgroundSync(
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      recorder({ queueAfterOnline: { pending: 0, delivered: 2 } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('2 times');
  });

  it('fails a queue that delivered one and still has more pending', async () => {
    const result = await checkBackgroundSync(
      spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }),
      recorder({ queueAfterOnline: { pending: 2, delivered: 1 } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('not draining');
  });

  it('goes offline, writes, then comes back online', async () => {
    // The sequence is the test. Without the return to online the replay could
    // never be observed and a correct application would be reported broken.
    const rec = recorder();
    await checkBackgroundSync(spec({ checks: ['BACKGROUND_SYNC_REPLAY'] }), rec.surface, ACTIVATED);
    expect(rec.environments.map((e) => e.offline)).toEqual([true, false]);
  });
});

// ─── The environment block ───────────────────────────────────────────────────

describe('drives offline through the environment block, not a bare CDP call', () => {
  it('sets BOTH the offline switch and the OFFLINE network profile', () => {
    /*
     * NETWORK_PROFILES in browser-matrix.ts says it plainly: Playwright's
     * offline mode and a zero-bandwidth throttling profile are different
     * mechanisms with different failure modes, and a spec that set one and not
     * the other was silently half-throttled.
     */
    expect(offlineEnvironment(undefined)).toEqual({ offline: true, network: 'OFFLINE' });
  });

  it('puts the network back with NO_THROTTLING rather than leaving OFFLINE in place', () => {
    /*
     * Returning the spec's own block unchanged would leave an OFFLINE profile
     * in place, so connectivity would never return and BACKGROUND_SYNC_REPLAY
     * would report a working sync as broken.
     */
    expect(onlineEnvironment({ network: 'OFFLINE', offline: true })).toEqual({
      offline: false,
      network: 'NO_THROTTLING',
    });
  });

  it("preserves the spec's other environment fields in both directions", () => {
    const base: BrowserEnvironmentValue = { colourScheme: 'DARK', clipboard: true };
    expect(offlineEnvironment(base)).toMatchObject({ colourScheme: 'DARK', clipboard: true });
    expect(onlineEnvironment(base)).toMatchObject({ colourScheme: 'DARK', clipboard: true });
  });
});

// ─── Worker and manifest ─────────────────────────────────────────────────────

describe('asserts the worker and the manifest', () => {
  it('fails a worker stuck short of activated', async () => {
    const result = await runCheck(
      'SERVICE_WORKER_ACTIVATES',
      spec(),
      recorder().surface,
      { ...ACTIVATED, state: 'installed' },
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('never reached');
  });

  it('fails a worker whose scope is not the one the spec expects', async () => {
    // A worker scoped above or below the paths it serves intercepts nothing,
    // which looks identical to working until the network goes down.
    const result = await runCheck(
      'SERVICE_WORKER_ACTIVATES',
      spec({ expectScope: '/app/' }),
      recorder().surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('/app/');
  });

  it.each(REQUIRED_MANIFEST_FIELDS)('fails a manifest missing %s', async (field) => {
    const fields = { ...GOOD_MANIFEST.fields, [field]: false };
    const result = await runCheck(
      'MANIFEST_VALID',
      spec({ checks: ['MANIFEST_VALID'] }),
      recorder({ manifest: { ...GOOD_MANIFEST, fields } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain(field);
  });

  it('fails a manifest declaring icons with no sizes', async () => {
    const result = await runCheck(
      'MANIFEST_VALID',
      spec({ checks: ['MANIFEST_VALID'] }),
      recorder({ manifest: { ...GOOD_MANIFEST, iconSizes: [] } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
  });

  it('fails a missing manifest rather than calling it inapplicable', async () => {
    /*
     * Unlike a missing service worker, this IS a defect when the check was
     * asked for: a spec naming MANIFEST_VALID is an application claiming to be
     * installable.
     */
    const result = await runCheck(
      'MANIFEST_VALID',
      spec({ checks: ['MANIFEST_VALID'] }),
      recorder({ manifest: null }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
  });

  it('fails an update that leaves the previous build serving every tab', async () => {
    // The skipWaiting/clients.claim bug: a deployed fix that nobody receives
    // until they close every tab is a fix that did not ship.
    const result = await runCheck(
      'UPDATE_TAKES_OVER',
      spec({ checks: ['UPDATE_TAKES_OVER'] }),
      recorder({ updated: { ...ACTIVATED, state: 'installed' } }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('did not ship');
  });

  it('reports an unreadable install prompt as UNAVAILABLE, not as "not offered"', async () => {
    const result = await runCheck(
      'INSTALL_PROMPT_AVAILABLE',
      spec({ checks: ['INSTALL_PROMPT_AVAILABLE'] }),
      recorder({ installPrompt: null }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNAVAILABLE');
    expect(result.reason).toBe('CAPABILITY_ABSENT');
  });

  it('fails a page that never offers an install affordance', async () => {
    const result = await runCheck(
      'INSTALL_PROMPT_AVAILABLE',
      spec({ checks: ['INSTALL_PROMPT_AVAILABLE'] }),
      recorder({ installPrompt: false }).surface,
      ACTIVATED,
    );
    expect(result.verdict).toBe('UNMET');
    expect(result.detail).toContain('beforeinstallprompt');
  });
});

// ─── The execution ───────────────────────────────────────────────────────────

describe('reports the run honestly', () => {
  it('passes with no disclosure when everything was measured and met', async () => {
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['SERVICE_WORKER_ACTIVATES', 'MANIFEST_VALID'] }),
      deps(),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toBeNull();
    expect(statuses(execution)).toEqual(['PASSED', 'PASSED']);
  });

  it('records UNAVAILABLE and NOT_APPLICABLE as SKIPPED steps, never failed ones', async () => {
    // `error` on a StepResult means "this failed", and neither of them did.
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['INSTALL_PROMPT_AVAILABLE', 'SERVICE_WORKER_ACTIVATES'] }),
      deps({ installPrompt: null, registration: null }),
    );
    expect(statuses(execution)).toEqual(['SKIPPED', 'SKIPPED']);
    expect(execution.steps.every((s) => s.error === null)).toBe(true);
  });

  it('is NOT_RUN when the page or its registration could not be read', async () => {
    /*
     * Not NOT_APPLICABLE. A navigation that threw does not establish that the
     * application has no service worker — claiming it did would fabricate a
     * fact about the customer's code.
     */
    const execution = await runPwaTest(ctx(), test({}), spec(), deps({ throwOn: 'registration' }));
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('NOT_RUN');
    expect(execution.notRun?.why).toContain('could not be read');
  });

  it('treats an adapter that threw mid-check as UNAVAILABLE, not as a finding', async () => {
    const throwing: PwaBrowserSurface = {
      ...recorder().surface,
      manifest: () => Promise.reject(new Error('manifest fetch exploded')),
    };
    const execution = await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['MANIFEST_VALID', 'SERVICE_WORKER_ACTIVATES'] }),
      { browser: throwing },
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.errorMessage).toContain('NOT MEASURED');
    expect(execution.errorMessage).toContain('manifest fetch exploded');
  });

  it('reads the registration once, before any check', async () => {
    /*
     * Asking per check would register the worker repeatedly and make
     * UPDATE_TAKES_OVER assert against a worker a previous check had replaced.
     */
    const rec = recorder();
    const registration = vi.spyOn(rec.surface, 'registration');
    await runPwaTest(
      ctx(),
      test({}),
      spec({ checks: ['SERVICE_WORKER_ACTIVATES', 'UPDATE_TAKES_OVER'] }),
      { browser: rec.surface },
    );
    expect(registration).toHaveBeenCalledTimes(1);
  });

  it('reports CANCELLED rather than a pass over the checks it did reach', async () => {
    const controller = new AbortController();
    controller.abort();
    const execution = await runPwaTest(
      ctx({ signal: controller.signal }),
      test({}),
      spec(),
      deps(),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.notRun?.kind).toBe('CANCELLED');
  });
});

// ─── Validate ────────────────────────────────────────────────────────────────

describe('refuses a spec before anything is driven', () => {
  it('refuses OFFLINE_NAVIGATION with no path, per the shared schema', () => {
    /*
     * The schema's own refinement: a check with no path would assert that the
     * page it is already on still renders, which a warm in-memory document does
     * whether a worker exists or not.
     */
    expect(() =>
      pwaPlugin.validate(test({ path: '/a', checks: ['OFFLINE_NAVIGATION'] })),
    ).toThrow(/invalid spec/);
  });

  it('refuses CACHE_FIRST with no path, so it cannot compare a volatile route', () => {
    /*
     * A false stale-cache finding is expensive: it sends somebody to audit a
     * caching layer that is working. The spec's `path` defaults to `/`, and a
     * root route very often differs on every load — a session greeting, a CSRF
     * token, a timestamp.
     */
    expect(() => pwaPlugin.validate(test({ path: '/', checks: ['CACHE_FIRST'] }))).toThrow(
      /STALE CACHE against a perfectly correct application/,
    );
  });

  it('accepts CACHE_FIRST with a named stable path', () => {
    expect(() =>
      pwaPlugin.validate(
        test({ path: '/', checks: ['CACHE_FIRST'], offlinePaths: ['/assets/app.js'] }),
      ),
    ).not.toThrow();
  });

  it('refuses an empty check list', () => {
    expect(() => pwaPlugin.validate(test({ path: '/', checks: [] }))).toThrow(/invalid spec/);
  });
});

// ─── The shipped adapter ─────────────────────────────────────────────────────

describe('ships an adapter that reports rather than fabricates', () => {
  it('rejects on registration rather than resolving null', async () => {
    /*
     * THE WORST FABRICATION AVAILABLE HERE. A null registration is the
     * NOT_APPLICABLE signal, so resolving one with no browser would report
     * "your application has no service worker" about an application that was
     * never loaded — a fabricated fact about the customer's code.
     */
    await expect(unavailablePwaBrowser.registration()).rejects.toThrow(/No browser context/);
    await expect(unavailablePwaBrowser.visit('/')).rejects.toThrow(/Nothing was measured/);
    await expect(unavailablePwaBrowser.manifest()).rejects.toThrow();
    await expect(unavailablePwaBrowser.fetchBody('/')).rejects.toThrow();
    await expect(unavailablePwaBrowser.applyEnvironment({})).rejects.toThrow();
    await expect(unavailablePwaBrowser.enqueueWrite('/')).rejects.toThrow();
  });

  it('resolves null only where null genuinely means "cannot see"', async () => {
    expect(await unavailablePwaBrowser.syncQueue()).toBeNull();
    expect(await unavailablePwaBrowser.installPromptOffered()).toBeNull();
    expect(await unavailablePwaBrowser.updateWorker()).toBeNull();
  });

  it('defaults to the unavailable surface, and setPwaDeps restores', () => {
    const previous = setPwaDeps(deps());
    expect(previous.browser).toBe(unavailablePwaBrowser);
    const restored = setPwaDeps(previous);
    expect(restored.browser).not.toBe(unavailablePwaBrowser);
  });
});
