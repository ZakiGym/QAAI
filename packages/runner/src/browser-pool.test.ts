/**
 * Tests for the browser pool.
 *
 * Most of this file runs against a fake launcher rather than a real Chromium,
 * for the same reason the pool exists: a launch is most of a second, and a
 * suite that spends a minute proving a cache works is a suite people stop
 * running. The fake models the three behaviours the pool actually depends on —
 * `isConnected()`, the `disconnected` event, and `contexts()` — so the logic
 * under test is the real logic.
 *
 * What is pinned here, in rough order of how much damage it would do if it
 * regressed:
 *
 *  1. **Contexts never survive a test.** Reusing a browser is a performance
 *     win; reusing a context would make results depend on test order. The
 *     release path closes every context the borrower left open, and if that
 *     ever stops happening this suite fails loudly.
 *  2. **A dead browser is never handed out.** A crash must produce a new
 *     browser, not a handle whose every call throws — that would turn one
 *     crashed test into every subsequent test failing for a reason that has
 *     nothing to do with the application.
 *  3. **Pooling never fails a test.** Unserialisable options, a full pool, a
 *     failed pooled launch, a pool that has been shut down: every one of them
 *     falls back to a direct launch and the caller cannot tell.
 *  4. **Nothing leaks.** Idle browsers close, shutdown closes browsers that are
 *     mid-launch, and a browser that finishes starting after shutdown is closed
 *     rather than orphaned.
 *
 * One test at the end drives a real Chromium, because a pool that works
 * perfectly against a fake and not against Playwright is worth nothing. It
 * SKIPS with an install hint when no browser is installed, rather than failing
 * and blaming the application for the machine's setup.
 */

import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, LaunchOptions } from 'playwright';
import {
  acquireBrowser,
  browserPoolStats,
  resetBrowserPoolForTests,
  setBrowserLauncherForTests,
  shutdownBrowserPool,
  withBrowser,
} from './browser-pool.js';

// ─── A fake browser ──────────────────────────────────────────────────────────

class FakeContext {
  closed = false;
  constructor(private readonly owner: FakeBrowser) {}
  async close(): Promise<void> {
    this.closed = true;
    this.owner.forget(this);
  }
}

class FakeBrowser {
  connected = true;
  closeCalls = 0;
  private readonly openContexts: FakeContext[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly launchOptions: LaunchOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  on(event: string, listener: () => void): void {
    if (event === 'disconnected') this.listeners.add(listener);
  }

  off(event: string, listener: () => void): void {
    if (event === 'disconnected') this.listeners.delete(listener);
  }

  contexts(): FakeContext[] {
    return [...this.openContexts];
  }

  async newContext(): Promise<FakeContext> {
    const context = new FakeContext(this);
    this.openContexts.push(context);
    return context;
  }

  forget(context: FakeContext): void {
    const index = this.openContexts.indexOf(context);
    if (index >= 0) this.openContexts.splice(index, 1);
  }

  /** Playwright emits `disconnected` on a deliberate close too. So does this. */
  async close(): Promise<void> {
    this.closeCalls++;
    this.die();
  }

  /** An unexpected death: crash, SIGKILL, driver connection lost. */
  die(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of [...this.listeners]) listener();
  }
}

interface Recorder {
  launched: FakeBrowser[];
  launchCount: number;
  failNext: Error | null;
  /** While true, launches block — used to race a shutdown against a launch. */
  hold: boolean;
  /** Set while a launch is blocked; call it to let that launch finish. */
  letGo: (() => void) | null;
}

function installFakeLauncher(): Recorder {
  const recorder: Recorder = {
    launched: [],
    launchCount: 0,
    failNext: null,
    hold: false,
    letGo: null,
  };

  setBrowserLauncherForTests(() => ({
    launch: async (options: LaunchOptions = {}) => {
      recorder.launchCount++;
      if (recorder.hold) {
        await new Promise<void>((resolve) => {
          recorder.letGo = resolve;
        });
      }
      if (recorder.failNext) {
        const error = recorder.failNext;
        recorder.failNext = null;
        throw error;
      }
      const browser = new FakeBrowser(options);
      recorder.launched.push(browser);
      return browser as unknown as Browser;
    },
  }));

  return recorder;
}

/** The fakes are structurally compatible; the cast keeps the pool's API honest. */
function asFake(browser: Browser): FakeBrowser {
  return browser as unknown as FakeBrowser;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const ENV_KEYS = ['QAAI_BROWSER_POOL', 'QAAI_BROWSER_POOL_IDLE_MS', 'QAAI_BROWSER_POOL_MAX'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  await resetBrowserPoolForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  await resetBrowserPoolForTests();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ─── Reuse ───────────────────────────────────────────────────────────────────

describe('reuse', () => {
  it('launches once and serves every later acquire from the same browser', async () => {
    const recorder = installFakeLauncher();

    const first = await acquireBrowser();
    await first.release();
    const second = await acquireBrowser();
    await second.release();
    const third = await acquireBrowser();
    await third.release();

    expect(recorder.launchCount).toBe(1);
    expect(first.browser).toBe(second.browser);
    expect(second.browser).toBe(third.browser);
    expect(first.pooled).toBe(true);

    const stats = browserPoolStats();
    expect(stats.launches).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.directLaunches).toBe(0);
  });

  it('launches exactly once for concurrent acquires of the same configuration', async () => {
    const recorder = installFakeLauncher();

    const leases = await Promise.all([
      acquireBrowser(),
      acquireBrowser(),
      acquireBrowser(),
      acquireBrowser(),
    ]);

    expect(recorder.launchCount).toBe(1);
    expect(new Set(leases.map((lease) => lease.browser)).size).toBe(1);

    await Promise.all(leases.map((lease) => lease.release()));
  });

  it('releases idempotently, so a double release cannot free a browser twice', async () => {
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '0';

    const held = await acquireBrowser();
    const other = await acquireBrowser();
    expect(held.browser).toBe(other.browser);

    await held.release();
    await held.release();
    await held.release();

    // One real lease is still out, so the browser must still be open.
    expect(asFake(other.browser).isConnected()).toBe(true);
    await other.release();
    expect(asFake(other.browser).isConnected()).toBe(false);
  });

  it('withBrowser releases even when the body throws', async () => {
    installFakeLauncher();

    await expect(
      withBrowser({}, async () => {
        throw new Error('the test failed');
      }),
    ).rejects.toThrow('the test failed');

    // Released, not leaked: the next acquire reuses it instead of launching.
    const lease = await acquireBrowser();
    expect(browserPoolStats().launches).toBe(1);
    await lease.release();
  });
});

// ─── Isolation ───────────────────────────────────────────────────────────────

describe('isolation', () => {
  it('closes every context the borrower left open, so nothing outlives a test', async () => {
    installFakeLauncher();

    const lease = await acquireBrowser();
    const fake = asFake(lease.browser);
    const leaked = await fake.newContext();
    const alsoLeaked = await fake.newContext();

    await lease.release();

    expect(leaked.closed).toBe(true);
    expect(alsoLeaked.closed).toBe(true);
    expect(fake.contexts()).toHaveLength(0);
  });

  it('leaves contexts alone while another lease is still using the browser', async () => {
    installFakeLauncher();

    const first = await acquireBrowser();
    const second = await acquireBrowser();
    const stillRunning = await asFake(second.browser).newContext();

    await first.release();

    // The second test is mid-flight. Closing its context here would be the
    // pool breaking a test rather than speeding one up.
    expect(stillRunning.closed).toBe(false);

    await second.release();
    expect(stillRunning.closed).toBe(true);
  });
});

// ─── Keying ──────────────────────────────────────────────────────────────────

describe('keying', () => {
  it('treats different launch options as different browsers', async () => {
    const recorder = installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_MAX = '10';

    const acquisitions = [
      await acquireBrowser({ launchOptions: { headless: true } }),
      await acquireBrowser({ launchOptions: { headless: false } }),
      await acquireBrowser({ launchOptions: { args: ['--lang=fr-FR'] } }),
      await acquireBrowser({ launchOptions: { args: ['--lang=de-DE'] } }),
      await acquireBrowser({ launchOptions: { channel: 'chrome' } }),
      await acquireBrowser({ launchOptions: { proxy: { server: 'http://127.0.0.1:8080' } } }),
    ];

    expect(recorder.launchCount).toBe(6);
    expect(new Set(acquisitions.map((lease) => lease.browser)).size).toBe(6);

    await Promise.all(acquisitions.map((lease) => lease.release()));
  });

  it('treats a different browser engine as a different browser', async () => {
    const recorder = installFakeLauncher();

    const chromiumLease = await acquireBrowser({ browserName: 'chromium' });
    const firefoxLease = await acquireBrowser({ browserName: 'firefox' });

    expect(recorder.launchCount).toBe(2);
    expect(chromiumLease.browser).not.toBe(firefoxLease.browser);

    await chromiumLease.release();
    await firefoxLease.release();
  });

  it('does not care about key order, so equivalent options share one browser', async () => {
    const recorder = installFakeLauncher();

    const first = await acquireBrowser({
      launchOptions: { headless: true, args: ['--no-sandbox'], timeout: 5000 },
    });
    await first.release();
    const second = await acquireBrowser({
      launchOptions: { timeout: 5000, headless: true, args: ['--no-sandbox'] },
    });

    expect(recorder.launchCount).toBe(1);
    expect(second.browser).toBe(first.browser);
    await second.release();
  });

  it('keeps args in order, because two orderings are two configurations', async () => {
    const recorder = installFakeLauncher();

    const first = await acquireBrowser({ launchOptions: { args: ['--a', '--b'] } });
    const second = await acquireBrowser({ launchOptions: { args: ['--b', '--a'] } });

    expect(recorder.launchCount).toBe(2);
    expect(first.browser).not.toBe(second.browser);

    await first.release();
    await second.release();
  });
});

// ─── Crash replacement ───────────────────────────────────────────────────────

describe('a browser that dies', () => {
  it('is replaced rather than handed out again', async () => {
    const recorder = installFakeLauncher();

    const first = await acquireBrowser();
    const doomed = asFake(first.browser);
    await first.release();

    doomed.die();

    const second = await acquireBrowser();
    expect(recorder.launchCount).toBe(2);
    expect(second.browser).not.toBe(first.browser);
    expect(asFake(second.browser).isConnected()).toBe(true);
    expect(browserPoolStats().disconnects).toBe(1);

    await second.release();
  });

  it('is dropped from the pool the moment it disconnects', async () => {
    installFakeLauncher();

    const lease = await acquireBrowser();
    expect(browserPoolStats().browsers).toBe(1);

    asFake(lease.browser).die();
    expect(browserPoolStats().browsers).toBe(0);

    // Releasing a lease on a dead browser must not throw or resurrect it.
    await expect(lease.release()).resolves.toBeUndefined();
    expect(browserPoolStats().browsers).toBe(0);
  });

  it('does not count a deliberate close as a crash', async () => {
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '0';

    const lease = await acquireBrowser();
    await lease.release();

    expect(asFake(lease.browser).closeCalls).toBe(1);
    expect(browserPoolStats().disconnects).toBe(0);
    expect(browserPoolStats().closes).toBe(1);
  });
});

// ─── Bounds ──────────────────────────────────────────────────────────────────

describe('bounds', () => {
  it('closes a browser that has been idle too long', async () => {
    vi.useFakeTimers();
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '30000';

    const lease = await acquireBrowser();
    await lease.release();
    expect(browserPoolStats().browsers).toBe(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(browserPoolStats().browsers).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserPoolStats().browsers).toBe(0);
    expect(asFake(lease.browser).isConnected()).toBe(false);
  });

  it('never closes a browser a test is still holding', async () => {
    vi.useFakeTimers();
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '1000';

    const lease = await acquireBrowser();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(asFake(lease.browser).isConnected()).toBe(true);
    expect(browserPoolStats().browsers).toBe(1);
    await lease.release();
  });

  it('re-arms the idle clock on each release', async () => {
    vi.useFakeTimers();
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '1000';

    const first = await acquireBrowser();
    await first.release();
    await vi.advanceTimersByTimeAsync(800);

    const second = await acquireBrowser();
    expect(second.browser).toBe(first.browser);
    await second.release();

    await vi.advanceTimersByTimeAsync(800);
    expect(asFake(first.browser).isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(asFake(first.browser).isConnected()).toBe(false);
  });

  it('evicts the least recently used idle browser when the pool is full', async () => {
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_MAX = '2';

    const a = await acquireBrowser({ launchOptions: { args: ['--a'] } });
    await a.release();
    const b = await acquireBrowser({ launchOptions: { args: ['--b'] } });
    await b.release();

    // Touch A so B becomes the least recently used.
    const aAgain = await acquireBrowser({ launchOptions: { args: ['--a'] } });
    await aAgain.release();

    const c = await acquireBrowser({ launchOptions: { args: ['--c'] } });

    expect(browserPoolStats().browsers).toBe(2);
    expect(browserPoolStats().evictions).toBe(1);
    expect(asFake(b.browser).isConnected()).toBe(false);
    expect(asFake(a.browser).isConnected()).toBe(true);

    await c.release();
  });

  it('launches directly rather than stalling when every pooled browser is busy', async () => {
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_MAX = '1';

    const held = await acquireBrowser({ launchOptions: { args: ['--a'] } });
    const overflow = await acquireBrowser({ launchOptions: { args: ['--b'] } });

    expect(overflow.pooled).toBe(false);
    expect(browserPoolStats().browsers).toBe(1);
    expect(browserPoolStats().directLaunches).toBe(1);

    // A direct lease closes its own browser, because nothing else can.
    await overflow.release();
    expect(asFake(overflow.browser).isConnected()).toBe(false);

    await held.release();
  });
});

// ─── Failing open ────────────────────────────────────────────────────────────

describe('pooling never fails a test', () => {
  it('falls back to a direct launch when the options cannot be keyed', async () => {
    installFakeLauncher();

    // `logger` is a live object with methods — not comparable, so the pool
    // refuses to guess whether two of them are the same configuration.
    const lease = await acquireBrowser({
      launchOptions: { logger: { isEnabled: () => true, log: () => {} } },
    });

    expect(lease.pooled).toBe(false);
    expect(browserPoolStats().browsers).toBe(0);
    expect(browserPoolStats().directLaunches).toBe(1);
    await lease.release();
  });

  it('falls back to a direct launch when a cyclic option cannot be keyed', async () => {
    installFakeLauncher();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const lease = await acquireBrowser({ launchOptions: cyclic });
    expect(lease.pooled).toBe(false);
    await lease.release();
  });

  it('falls back to a direct launch when the pooled launch fails', async () => {
    const recorder = installFakeLauncher();
    recorder.failNext = new Error('transient spawn failure');

    const lease = await acquireBrowser();

    expect(lease.pooled).toBe(false);
    expect(recorder.launchCount).toBe(2);
    expect(browserPoolStats().browsers).toBe(0);
    await lease.release();
  });

  it('surfaces the real launch error when the browser genuinely cannot start', async () => {
    setBrowserLauncherForTests(() => ({
      launch: async () => {
        throw new Error("Executable doesn't exist at /ms-playwright/chromium/chrome");
      },
    }));

    await expect(acquireBrowser()).rejects.toThrow("Executable doesn't exist");
  });

  it('bypasses the pool entirely when QAAI_BROWSER_POOL=0', async () => {
    const recorder = installFakeLauncher();
    process.env.QAAI_BROWSER_POOL = '0';

    const first = await acquireBrowser();
    await first.release();
    const second = await acquireBrowser();
    await second.release();

    expect(first.pooled).toBe(false);
    expect(recorder.launchCount).toBe(2);
    expect(browserPoolStats().browsers).toBe(0);
    expect(asFake(first.browser).isConnected()).toBe(false);
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe('shutdown', () => {
  it('closes every pooled browser', async () => {
    installFakeLauncher();
    process.env.QAAI_BROWSER_POOL_MAX = '5';

    const a = await acquireBrowser({ launchOptions: { args: ['--a'] } });
    const b = await acquireBrowser({ launchOptions: { args: ['--b'] } });
    await a.release();

    await shutdownBrowserPool();

    expect(asFake(a.browser).isConnected()).toBe(false);
    // Hard means hard: a browser still on lease is closed too, because a drain
    // that waits for in-flight work is a drain that can hang.
    expect(asFake(b.browser).isConnected()).toBe(false);
    expect(browserPoolStats().browsers).toBe(0);

    await b.release();
  });

  it('closes a browser that finishes launching after the shutdown began', async () => {
    const recorder = installFakeLauncher();
    recorder.hold = true;

    const acquiring = acquireBrowser();
    await vi.waitFor(() => expect(recorder.letGo).toBeTypeOf('function'));

    const draining = shutdownBrowserPool();

    // Let the launch complete now that the pool is closing. The fallback
    // launch that follows must not block on the same gate.
    recorder.hold = false;
    recorder.letGo?.();

    const lease = await acquiring;
    await draining;

    // It fell back to a direct launch (the pool was closing), and the browser
    // the pool had started is closed rather than orphaned.
    expect(recorder.launchCount).toBe(2);
    expect(recorder.launched[0]?.isConnected()).toBe(false);
    await lease.release();
    expect(recorder.launched[1]?.isConnected()).toBe(false);
  });

  it('keeps serving direct launches after shutdown, so a late job still runs', async () => {
    installFakeLauncher();
    await shutdownBrowserPool();

    const lease = await acquireBrowser();
    expect(lease.pooled).toBe(false);
    expect(browserPoolStats().browsers).toBe(0);

    await lease.release();
    expect(asFake(lease.browser).isConnected()).toBe(false);
  });
});

// ─── The real thing ──────────────────────────────────────────────────────────

/** The page-side `localStorage`, typed here because this package's lib has no DOM. */
interface WithStorage {
  localStorage: { setItem(key: string, value: string): void; getItem(key: string): string | null };
}

/**
 * A real HTTP origin with no server behind it. `localStorage` is unavailable on
 * `data:` URLs and this suite must not depend on anything being up on a port,
 * so the context fulfils the request itself.
 */
const ORIGIN = 'http://browser-pool.test/';

async function serveBlankPage(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>ok' }),
  );
}

const chromiumInstalled = ((): boolean => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumInstalled)('against a real Chromium', () => {
  it('reuses one process across acquires and keeps contexts isolated', async () => {
    setBrowserLauncherForTests(null);
    process.env.QAAI_BROWSER_POOL_IDLE_MS = '30000';

    const first = await acquireBrowser();
    expect(first.pooled).toBe(true);

    const contextA: BrowserContext = await first.browser.newContext();
    // A real origin, served by interception rather than by a server: storage is
    // disabled inside `data:` URLs, and the point of this test is storage.
    await serveBlankPage(contextA);
    const pageA = await contextA.newPage();
    await pageA.goto(ORIGIN);
    // Runs in the page, not in Node — hence the local typing rather than
    // widening this package's lib to include "dom".
    await pageA.evaluate(() => {
      (globalThis as unknown as WithStorage).localStorage.setItem('leaked', 'yes');
    });
    // A session cookie is what leakage actually rides on in practice — the
    // email-OTP plugin signs a user in, and that must not follow the browser.
    await contextA.addCookies([
      { name: 'session', value: 'signed-in', url: ORIGIN, httpOnly: true },
    ]);
    await first.release();

    // Same browser process...
    const second = await acquireBrowser();
    expect(second.browser).toBe(first.browser);
    expect(browserPoolStats().launches).toBe(1);
    expect(browserPoolStats().hits).toBe(1);

    // ...and the previous test's context is gone, storage with it.
    expect(second.browser.contexts()).toHaveLength(0);

    const contextB = await second.browser.newContext();
    await serveBlankPage(contextB);
    const pageB = await contextB.newPage();
    await pageB.goto(ORIGIN);
    const leaked = await pageB.evaluate(() =>
      (globalThis as unknown as WithStorage).localStorage.getItem('leaked'),
    );
    expect(leaked).toBeNull();
    expect(await contextB.cookies(ORIGIN)).toEqual([]);

    await second.release();
    await shutdownBrowserPool();
    expect(first.browser.isConnected()).toBe(false);
  }, 60_000);
});

if (!chromiumInstalled) {
  // Not a failure: the machine has no browser installed, which says nothing
  // about the code under test. Say what to run and move on.
  console.warn(
    '[browser-pool] Skipped the real-Chromium test: no browser installed. Run `npx playwright install chromium` to include it.',
  );
}
