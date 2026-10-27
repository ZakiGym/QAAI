/**
 * ADVERSARIAL COUNTER-TESTS, written against the plugin rather than with it.
 *
 * Each one is an attempt to MAKE the plugin report a pass it did not earn,
 * built from a fixture the colocated suite does not hold. Where a sweep over a
 * whole exported union was possible it is done that way rather than over the
 * members somebody remembered to list: that is what makes a new member
 * un-passable by default instead of un-passable by review.
 */
import { describe, expect, it, vi } from 'vitest';
import { pwaTestSpecSchema, type RunContext } from '@qaai/shared';
import {
  runPwaTest,
  PWA_VERDICT_LIST,
  checkServiceWorker,
  checkOfflineNavigation,
  type PwaBrowserSurface,
} from '../plugins/pwa.js';

/** An application with NO service worker, and an adapter that works perfectly. */
function appWithNoWorker(): PwaBrowserSurface {
  return {
    visit: () => Promise.resolve({ ok: true, status: 200, bodyText: 'Home' }),
    // null = a FACT about the application, not an adapter failure.
    registration: () => Promise.resolve(null),
    manifest: () => Promise.resolve(null),
    applyEnvironment: () => Promise.resolve(),
    fetchBody: () => Promise.resolve({ ok: true, status: 200, text: 'Home', fromServiceWorker: null }),
    enqueueWrite: () => Promise.resolve(),
    syncQueue: () => Promise.resolve(null),
    installPromptOffered: () => Promise.resolve(null),
    updateWorker: () => Promise.resolve(null),
  } as unknown as PwaBrowserSurface;
}

function ctx(): RunContext {
  return {
    baseUrl: 'https://app.example.com',
    signal: new AbortController().signal,
    logger: { step: vi.fn(), log: vi.fn(), finding: vi.fn() },
    determinism: { randomSeed: 7, timezone: 'UTC', locale: 'en-GB' },
  } as unknown as RunContext;
}

const TEST = { id: 't-pwa', name: 'offline', type: 'PWA', spec: {} } as never;

describe('ADVERSARY — PWA: no worker is NOT_APPLICABLE, neither pass nor fail', () => {
  it('reports SKIPPED + UNSUPPORTED, never PASSED and never FAILED', async () => {
    const spec = pwaTestSpecSchema.parse({
      path: '/',
      checks: ['SERVICE_WORKER_ACTIVATES', 'OFFLINE_NAVIGATION', 'CACHE_FIRST'],
      offlinePaths: ['/dashboard'],
    });
    const out = await runPwaTest(ctx(), TEST, spec, { browser: appWithNoWorker() });
    expect(out.status).toBe('SKIPPED');
    expect(out.notRun).not.toBeNull();
    expect(out.notRun?.kind).toBe('UNSUPPORTED');
    expect(out.notRun?.why).toMatch(/service worker/i);
    // Every step is a non-failure: no check may be red for an absent worker.
    expect(out.steps.filter((s) => s.status === 'FAILED')).toEqual([]);
    expect(out.steps.filter((s) => s.status === 'PASSED')).toEqual([]);
  });

  it('keeps NOT_APPLICABLE out of MET and out of UNMET at the check level', async () => {
    const spec = pwaTestSpecSchema.parse({ path: '/', checks: ['SERVICE_WORKER_ACTIVATES'] });
    const r = await checkServiceWorker(null, spec);
    expect(r.verdict).toBe('NOT_APPLICABLE');
    expect(r.verdict).not.toBe('MET');
    expect(r.verdict).not.toBe('UNMET');
  });

  it('an adapter that THROWS is NOT_RUN, which is a different answer from no worker', async () => {
    const broken = {
      ...appWithNoWorker(),
      visit: () => Promise.reject(new Error('chromium not on PATH')),
    } as unknown as PwaBrowserSurface;
    const spec = pwaTestSpecSchema.parse({ path: '/', checks: ['SERVICE_WORKER_ACTIVATES'] });
    const out = await runPwaTest(ctx(), TEST, spec, { browser: broken });
    expect(out.status).toBe('SKIPPED');
    expect(out.notRun?.kind).toBe('NOT_RUN');
    // The two answers must not be the same string.
    const noWorker = await runPwaTest(
      ctx(),
      TEST,
      pwaTestSpecSchema.parse({ path: '/', checks: ['SERVICE_WORKER_ACTIVATES'] }),
      { browser: appWithNoWorker() },
    );
    expect(out.notRun?.kind).not.toBe(noWorker.notRun?.kind);
  });

  it('the verdict union has exactly the four members and NOT_APPLICABLE is one', () => {
    expect([...PWA_VERDICT_LIST].sort()).toEqual(['MET', 'NOT_APPLICABLE', 'UNAVAILABLE', 'UNMET']);
  });

  it('offline navigation with a worker that serves nothing is UNMET, not NOT_APPLICABLE', async () => {
    const withWorker = {
      ...appWithNoWorker(),
      registration: () => Promise.resolve({ scope: '/', scriptUrl: '/sw.js', active: true, state: 'activated' }),
      // Offline navigation fails: the app is NOT offline-capable. A real defect.
      visit: () => Promise.resolve({ ok: false, status: 0, bodyText: 'You are offline' }),
    } as unknown as PwaBrowserSurface;
    const spec = pwaTestSpecSchema.parse({
      path: '/',
      checks: ['OFFLINE_NAVIGATION'],
      offlinePaths: ['/dashboard'],
    });
    const reg = { scope: '/', scriptUrl: '/sw.js', active: true, state: 'activated' };
    const r = await checkOfflineNavigation(spec, withWorker, reg as never);
    expect(r.verdict).toBe('UNMET');
  });
});
