/**
 * A pool of Playwright **browsers**, shared by every test a worker process runs.
 *
 * Three plugins used to call `chromium.launch()` once per test — accessibility,
 * visual and email-OTP. A launch is 300–800ms of process spawn, profile setup
 * and CDP handshake before a single assertion runs; on a 200-test suite that is
 * minutes of pure overhead. This file launches a browser once per distinct
 * launch configuration and hands the same one to every test that asks for it.
 *
 * ── The line this file will not cross ────────────────────────────────────────
 *
 * The BROWSER is reused. The CONTEXT never is.
 *
 * A fresh `BrowserContext` per test is what guarantees isolation — cookies,
 * localStorage, IndexedDB, permissions, service workers, HTTP cache, and the
 * storage state an authenticated run injects. Reusing one would trade minutes
 * of CI time for tests that pass or fail depending on what ran before them, and
 * that is the single worst trade this product could make. A QA tool whose
 * results depend on test order is not a QA tool; it is a random number
 * generator with a logo. So every caller still gets a browser and is expected
 * to call `browser.newContext()` itself, and this pool actively closes any
 * context still open when the last lease on a browser is released, so nothing a
 * test created can outlive it.
 *
 * ── The other rule: pooling is an optimisation, and optimisations fail open ──
 *
 * If anything about pooling is uncertain — the launch options cannot be
 * serialised into a key, the pool is at capacity, a pooled launch failed, the
 * pool has been shut down — the caller gets a plain `chromium.launch()` and the
 * test runs exactly as it did before this file existed. Pooling can make a run
 * faster; it must never be the reason a run fails.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 *
 *  - `QAAI_BROWSER_POOL=0`          turn pooling off entirely (escape hatch).
 *  - `QAAI_BROWSER_POOL_IDLE_MS`    close an unused browser after this long
 *                                   (default 30s; `0` closes it immediately).
 *  - `QAAI_BROWSER_POOL_MAX`        distinct browsers kept alive (default 4).
 *  - `shutdownBrowserPool()`        hard close, for the worker's SIGTERM path,
 *                                   so a draining process never leaks Chromium.
 *
 * Idle timers are `unref`'d, so a warm browser waiting to expire can never be
 * the reason a process refuses to exit.
 */

import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserType, LaunchOptions } from 'playwright';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface AcquireBrowserOptions {
  /** Defaults to chromium, which is what every pooled plugin uses today. */
  browserName?: BrowserName;
  /** Passed straight to `browserType.launch()` and part of the pool key. */
  launchOptions?: LaunchOptions;
}

/**
 * A borrowed browser. `release()` is what you call instead of `close()`.
 *
 * `pooled` is exposed for diagnostics and tests, not for branching in plugins:
 * `release()` already does the right thing for both cases — it returns a pooled
 * browser to the pool and closes a fallback one.
 */
export interface BrowserLease {
  readonly browser: Browser;
  readonly pooled: boolean;
  release(): Promise<void>;
}

export interface BrowserPoolStats {
  /** Browsers currently held (open or mid-launch). */
  browsers: number;
  /** Launches the pool performed itself. */
  launches: number;
  /** Acquisitions served by an already-open browser — the savings. */
  hits: number;
  /** Acquisitions that bypassed the pool and launched directly. */
  directLaunches: number;
  /** Browsers closed early to stay under `QAAI_BROWSER_POOL_MAX`. */
  evictions: number;
  /** Pooled browsers that died on their own (crash, kill, driver loss). */
  disconnects: number;
  /** Browsers this pool closed, for any reason. */
  closes: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

// Read per call rather than at import time: a worker may set these after the
// module graph is loaded, and tests need to change them between cases.

function poolEnabled(): boolean {
  return process.env.QAAI_BROWSER_POOL !== '0';
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function idleMs(): number {
  return envInt('QAAI_BROWSER_POOL_IDLE_MS', 30_000);
}

function maxBrowsers(): number {
  return Math.max(1, envInt('QAAI_BROWSER_POOL_MAX', 4));
}

// ─── The key ─────────────────────────────────────────────────────────────────

/**
 * Two different launch configurations are two different browsers, never one.
 *
 * `headless`, `args`, `proxy` and `channel` are the ones that bite — a headed
 * browser and a headless one render differently, `--lang` changes what a
 * localisation test sees, and a proxy decides where the traffic goes. Rather
 * than list those four and hope nobody adds a fifth, the key covers the *whole*
 * options object: anything the caller bothered to set is part of the identity.
 *
 * `args` order is preserved rather than sorted. Chromium flags are order
 * sensitive in ways that are not worth reasoning about, so two orderings are
 * treated as two configurations. That errs toward launching one browser too
 * many, which is the harmless direction.
 */
function stableStringify(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return JSON.stringify(value) ?? 'null';
  }
  if (type === 'undefined') return 'undefined';

  if (type === 'object') {
    const object = value as object;
    if (seen.has(object)) {
      throw new Error('launch options contain a cycle and cannot be pooled');
    }
    seen.add(object);
    try {
      if (Array.isArray(object)) {
        return `[${object.map((item) => stableStringify(item, seen)).join(',')}]`;
      }
      const record = object as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const body = keys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
        .join(',');
      return `{${body}}`;
    } finally {
      seen.delete(object);
    }
  }

  // A function (`logger`), a symbol, a bigint: not comparable, so the caller
  // gets an unpooled browser rather than one whose configuration we only think
  // we matched.
  throw new Error(`launch options contain a non-serialisable ${type} and cannot be pooled`);
}

function keyFor(browserName: BrowserName, launchOptions: LaunchOptions): string {
  return `${browserName}::${stableStringify(launchOptions)}`;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface PoolEntry {
  key: string;
  browserName: BrowserName;
  launchOptions: LaunchOptions;
  browser: Browser | null;
  /** In-flight launch, so N concurrent acquires cause exactly one launch. */
  pending: Promise<Browser> | null;
  /** Outstanding leases. The idle clock only starts at zero. */
  leases: number;
  /**
   * A counter, not a timestamp, and that distinction is a bug this pool had.
   * `Date.now()` has millisecond resolution while a warm pool can serve several
   * tests inside one millisecond — which made "least recently used" a coin flip
   * decided by map insertion order, and evicted the browser that had just been
   * used instead of the one nobody had touched.
   */
  lastUsedSeq: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onDisconnected: (() => void) | null;
}

let useCounter = 0;
function nextUse(): number {
  return ++useCounter;
}

type Launcher = Pick<BrowserType, 'launch'>;
type LauncherFactory = (name: BrowserName) => Launcher;

const realLauncherFactory: LauncherFactory = (name) =>
  name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium;

let launcherFactory: LauncherFactory = realLauncherFactory;

const entries = new Map<string, PoolEntry>();
let closed = false;

const stats: BrowserPoolStats = {
  browsers: 0,
  launches: 0,
  hits: 0,
  directLaunches: 0,
  evictions: 0,
  disconnects: 0,
  closes: 0,
};

export function browserPoolStats(): BrowserPoolStats {
  return { ...stats, browsers: entries.size };
}

// ─── Lifecycle plumbing ──────────────────────────────────────────────────────

function clearIdle(entry: PoolEntry): void {
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function detach(entry: PoolEntry, browser: Browser | null): void {
  if (browser && entry.onDisconnected) {
    browser.off('disconnected', entry.onDisconnected);
  }
  entry.onDisconnected = null;
}

/**
 * A browser that died must be replaced, never handed out again. Playwright
 * fires `disconnected` when the process crashes, is killed, or the driver
 * connection drops; dropping the entry on that event means the next acquire
 * launches a fresh one instead of returning a corpse whose every call throws.
 */
function attachDisconnect(entry: PoolEntry, browser: Browser): void {
  const handler = (): void => {
    stats.disconnects++;
    if (entry.browser === browser) entry.browser = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    clearIdle(entry);
    entry.onDisconnected = null;
  };
  entry.onDisconnected = handler;
  browser.on('disconnected', handler);
}

async function closeEntry(entry: PoolEntry): Promise<void> {
  // A lease appeared between the idle timer firing and this running: the
  // browser is in use, so leave it alone and let the next release re-arm.
  if (entry.leases > 0) {
    entry.idleTimer = null;
    return;
  }

  clearIdle(entry);
  if (entries.get(entry.key) === entry) entries.delete(entry.key);

  const browser = entry.browser;
  entry.browser = null;
  detach(entry, browser);

  if (browser) {
    stats.closes++;
    await browser.close().catch(() => {});
  }
}

/** Returned when the pool is full and every browser in it is in use. */
const NO_ROOM = Symbol('browser-pool-full');

/**
 * Keep the pool bounded. When it is full, the least-recently-used browser that
 * nobody is holding gives up its slot; if every browser is in use, the caller
 * is told there is no room and launches directly. Waiting for a slot would turn
 * a full pool into a stalled run, which is far worse than one extra launch.
 *
 * Synchronous on purpose, and this is the second bug this pool had: the slot
 * has to be freed and claimed without an `await` in between. When this awaited,
 * four concurrent acquires of the same configuration all saw an empty map, all
 * created an entry, and the pool launched four browsers where it should have
 * launched one — the exact overhead it exists to remove. The victim is removed
 * from the map here and handed back for the caller to close *after* the new
 * entry is in place.
 */
function reserveSlot(): PoolEntry | null | typeof NO_ROOM {
  if (entries.size < maxBrowsers()) return null;

  let victim: PoolEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.leases > 0) continue;
    if (victim === null || entry.lastUsedSeq < victim.lastUsedSeq) victim = entry;
  }
  if (victim === null) return NO_ROOM;

  stats.evictions++;
  entries.delete(victim.key);
  return victim;
}

function launchInto(entry: PoolEntry): Promise<Browser> {
  const launch = async (): Promise<Browser> => {
    stats.launches++;
    const browser = await launcherFactory(entry.browserName).launch(entry.launchOptions);

    // Shutdown or eviction happened while this was launching. The browser is
    // already running, so closing it here is the difference between a clean
    // drain and a Chromium nobody owns.
    if (closed || entries.get(entry.key) !== entry) {
      await browser.close().catch(() => {});
      throw new Error('the browser pool was shut down while a browser was launching');
    }

    entry.browser = browser;
    attachDisconnect(entry, browser);
    return browser;
  };

  return launch().finally(() => {
    entry.pending = null;
  });
}

/**
 * Check a live browser out of an entry, or return null if there is not one.
 *
 * Synchronous on purpose: the "is it connected" test and the lease that acts on
 * the answer happen in one uninterrupted block, so nothing can close the
 * browser in between and hand the caller a corpse.
 */
function tryLease(entry: PoolEntry): Browser | null {
  const warm = entry.browser;
  if (!warm || !warm.isConnected()) return null;
  entry.leases++;
  entry.lastUsedSeq = nextUse();
  return warm;
}

/**
 * Returns a pooled browser, or `null` when the pool has no room for one.
 * Throws only if the underlying launch throws — the caller turns both into a
 * direct launch.
 */
async function checkout(
  key: string,
  browserName: BrowserName,
  launchOptions: LaunchOptions,
): Promise<{ entry: PoolEntry; browser: Browser } | null> {
  // Bounded retries: each pass either checks a browser out or replaces a dead
  // one. Two replacements is more than any real race needs, and the
  // fallthrough returns null rather than looping forever.
  for (let attempt = 0; attempt < 3; attempt++) {
    let entry = entries.get(key);

    if (!entry) {
      const evicted = reserveSlot();
      if (evicted === NO_ROOM) return null;

      // Claimed synchronously — no `await` between the miss above and this
      // write, or concurrent acquires each launch their own browser.
      entry = {
        key,
        browserName,
        launchOptions,
        browser: null,
        pending: null,
        leases: 0,
        lastUsedSeq: nextUse(),
        idleTimer: null,
        onDisconnected: null,
      };
      entries.set(key, entry);

      if (evicted) await closeEntry(evicted);
    }

    clearIdle(entry);

    if (entry.browser) {
      const warm = tryLease(entry);
      if (warm) {
        stats.hits++;
        return { entry, browser: warm };
      }
      // It died while it was sitting here. Replace it, never hand it out.
      await closeEntry(entry);
      continue;
    }

    if (!entry.pending) entry.pending = launchInto(entry);
    try {
      await entry.pending;
    } catch (err) {
      // Do not leave a browser-less entry occupying a slot in the pool.
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    }

    const fresh = tryLease(entry);
    if (fresh) return { entry, browser: fresh };

    // Launched and already gone. Clean up so the slot is not wasted, then try
    // once more rather than reporting a failure the caller cannot act on.
    if (entries.get(key) === entry) await closeEntry(entry);
  }

  return null;
}

function pooledLease(entry: PoolEntry, browser: Browser): BrowserLease {
  let released = false;
  return {
    browser,
    pooled: true,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await releaseEntry(entry, browser);
    },
  };
}

async function releaseEntry(entry: PoolEntry, browser: Browser): Promise<void> {
  entry.leases = Math.max(0, entry.leases - 1);
  entry.lastUsedSeq = nextUse();
  if (entry.leases > 0) return;

  // The isolation guarantee, enforced rather than trusted: no context a test
  // opened survives into the next test, even if the plugin forgot to close it.
  if (browser.isConnected()) {
    await Promise.all(browser.contexts().map((context) => context.close().catch(() => {})));
  }

  if (entries.get(entry.key) === entry && entry.browser === browser) {
    scheduleIdleClose(entry);
  }
}

function scheduleIdleClose(entry: PoolEntry): void {
  clearIdle(entry);
  const ms = idleMs();
  if (ms === 0) {
    void closeEntry(entry);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    void closeEntry(entry);
  }, ms);
  // A browser waiting to expire must never be the reason a process refuses to
  // exit. Optional because a faked timer in a test may not implement it.
  const timer: { unref?: () => void } = entry.idleTimer;
  timer.unref?.();
}

async function directLease(
  browserName: BrowserName,
  launchOptions: LaunchOptions,
): Promise<BrowserLease> {
  stats.directLaunches++;
  const browser = await launcherFactory(browserName).launch(launchOptions);
  let released = false;
  return {
    browser,
    pooled: false,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await browser.close().catch(() => {});
    },
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Borrow a browser. Call `release()` when the test is done — never `close()`,
 * which would take the browser away from every other test using it.
 *
 * This never throws for a pooling reason. If the pool cannot serve the request
 * it launches a browser directly, and the only error that can surface is the
 * one a plain `chromium.launch()` would have produced anyway.
 */
export async function acquireBrowser(options: AcquireBrowserOptions = {}): Promise<BrowserLease> {
  const browserName = options.browserName ?? 'chromium';
  const launchOptions = options.launchOptions ?? {};

  if (poolEnabled() && !closed) {
    try {
      const checked = await checkout(keyFor(browserName, launchOptions), browserName, launchOptions);
      if (checked) return pooledLease(checked.entry, checked.browser);
    } catch {
      // Unserialisable options, a pool at capacity, a launch that lost a race
      // with shutdown — all of it is a reason to launch directly, and none of
      // it is a reason to fail a test.
    }
  }

  return directLease(browserName, launchOptions);
}

/**
 * Borrow a browser for the duration of `fn`, releasing it however `fn` ends.
 * Preferred over `acquireBrowser` where the shape allows, because the release
 * cannot be forgotten on an early return.
 */
export async function withBrowser<T>(
  options: AcquireBrowserOptions,
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const lease = await acquireBrowser(options);
  try {
    return await fn(lease.browser);
  } finally {
    await lease.release();
  }
}

/**
 * Close every pooled browser and stop pooling.
 *
 * The worker calls this on SIGTERM so a draining process never leaves a
 * Chromium behind. It is deliberately *hard*: browsers still on lease are
 * closed too, because a shutdown that waits for in-flight work is a shutdown
 * that can hang. After this, `acquireBrowser` keeps working — it simply
 * launches directly, so a job that outlives the drain still runs and still
 * closes its own browser.
 */
export async function shutdownBrowserPool(): Promise<void> {
  closed = true;

  const all = [...entries.values()];
  entries.clear();

  await Promise.all(
    all.map(async (entry) => {
      clearIdle(entry);
      // Await an in-flight launch as well, or a browser that finishes starting
      // after this returns is exactly the leak this function exists to prevent.
      const pending = entry.pending ? await entry.pending.catch(() => null) : null;
      const browser = entry.browser ?? pending;
      entry.browser = null;
      detach(entry, browser);
      if (browser) {
        stats.closes++;
        await browser.close().catch(() => {});
      }
    }),
  );
}

/**
 * Test-only. Restores a pristine pool: everything closed, counters zeroed,
 * pooling re-enabled, and the real Playwright launchers back in place.
 */
export async function resetBrowserPoolForTests(): Promise<void> {
  await shutdownBrowserPool();
  closed = false;
  launcherFactory = realLauncherFactory;
  stats.browsers = 0;
  stats.launches = 0;
  stats.hits = 0;
  stats.directLaunches = 0;
  stats.evictions = 0;
  stats.disconnects = 0;
  stats.closes = 0;
}

/**
 * Test-only. Swaps in a fake launcher so the pool's keying, reuse, eviction,
 * crash-replacement and shutdown behaviour can be tested in milliseconds
 * instead of minutes. Pass `null` to restore the real one.
 */
export function setBrowserLauncherForTests(factory: LauncherFactory | null): void {
  launcherFactory = factory ?? realLauncherFactory;
}
