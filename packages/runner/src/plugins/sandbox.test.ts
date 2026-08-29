/**
 * The sandbox, tested by actually running hostile code in it.
 *
 * Everything here that matters is a REFUSAL, and a refusal is the one kind of
 * behaviour that cannot be verified by reading the source: `worker.terminate()`
 * either stops a non-yielding loop or it does not, `resourceLimits` either
 * bounds the heap or it does not, and `env: {}` either empties `process.env` or
 * it does not. Each of those is a claim sandbox.ts makes in prose, and each one
 * is a claim an operator would build a security decision on, so each gets a
 * plugin that tries the thing and an assertion against a literal rather than
 * against another expression from the same file.
 *
 * The two most important tests in this file:
 *
 *   - "forges a host call for a capability it never declared" proves the grant
 *     check is on the HOST side. The `api` object the bootstrap builds is a
 *     convenience; plugin code can import `node:worker_threads` and talk to
 *     parentPort itself, and if that were the only check the capability model
 *     would be decoration.
 *
 *   - "refuses a report too large to serialise, without flattening it" is the
 *     one whose failure mode is that this whole FILE dies. A 300 MB rope handed
 *     to JSON.stringify aborts the process, not the thread. If the assertion
 *     below is reached at all, the guard held.
 */

import { PLUGIN_CAPABILITIES, PLUGIN_CAPABILITY_COPY } from '@qaai/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SANDBOX_LIMITS,
  MEDIATED_CAPABILITIES,
  checkHttpDestination,
  clampLimits,
  classifyCapability,
  containmentTier,
  isPluginAtFault,
  runInSandbox,
} from './sandbox.js';
import type { Capability, SandboxLimits, SandboxOutcome } from './sandbox.js';

const REPORT = `{ status: 'PASSED', steps: [], findings: [] }`;

interface RunOptions {
  granted?: Capability[];
  limits?: Partial<SandboxLimits>;
  onCall?: (call: { capability: string; method: string; args: unknown[] }) => Promise<unknown>;
  signal?: AbortSignal;
  baseUrl?: string;
  spec?: unknown;
}

function run(code: string, options: RunOptions = {}): Promise<SandboxOutcome> {
  return runInSandbox({
    code,
    request: {
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:1/',
      spec: options.spec ?? { hello: 'world' },
      test: { id: 'test_1', name: 'a test', filePath: 'plugins/x.spec.ts', tags: [] },
    },
    granted: new Set(options.granted ?? []),
    limits: { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 8_000, ...options.limits },
    onCall: options.onCall ?? (async () => null),
    signal: options.signal ?? new AbortController().signal,
  });
}

/** Narrowing helper so a failing assertion prints the fault instead of `undefined`. */
function faultOf(outcome: SandboxOutcome): string {
  return outcome.ok ? `ok(${outcome.json.slice(0, 200)})` : outcome.fault.kind;
}

describe('the happy path', () => {
  it('runs a plugin and returns its report verbatim', async () => {
    const outcome = await run(`export const execute = async () => (${REPORT});`);
    expect(faultOf(outcome)).toContain('ok(');
    if (!outcome.ok) throw new Error('unreachable');
    expect(JSON.parse(outcome.json)).toEqual({ status: 'PASSED', steps: [], findings: [] });
    expect(outcome.usage.hostCalls).toBe(0);
  });

  it('hands the plugin its request and nothing else', async () => {
    // The plugin must see the spec and the test metadata, and must NOT see the
    // RunContext: no artifacts sink, no logger, no secrets bag.
    const outcome = await run(
      `export const execute = async (api, request) => ({
         status: 'PASSED',
         steps: [],
         findings: [],
         seen: { spec: request.spec, name: request.test.name, apiKeys: Object.keys(api) },
       });`,
    );
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).seen).toEqual({
      spec: { hello: 'world' },
      name: 'a test',
      // `baseUrl` is data; no capability was granted, so nothing else is there.
      apiKeys: ['baseUrl'],
    });
  });
});

describe('what the isolate cannot reach', () => {
  it('gives the plugin an empty process.env', async () => {
    // The vault key, DATABASE_URL and the S3 credentials are not merely
    // unreadable in here — they are absent. Asserting against the literal 0
    // rather than against anything the sandbox computed.
    const outcome = await run(
      `export const execute = async () => ({ status: 'PASSED', steps: [], findings: [], env: Object.keys(process.env).length });`,
    );
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).env).toBe(0);
  });

  it('cannot import the worker\'s own dependencies', async () => {
    // Node refuses bare specifiers from a data: URL. Without that, a plugin
    // could pick up playwright, @prisma/client or @qaai/storage off disk and
    // use our credentials with our libraries.
    const outcome = await run(`import pw from 'playwright'; export const execute = async () => ({});`);
    expect(faultOf(outcome)).toBe('LOAD_ERROR');
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.fault.message).toMatch(/playwright/);
  });
});

describe('capability grants are enforced by the host, not the api object', () => {
  it('shapes the api object to exactly what was granted', async () => {
    const outcome = await run(
      `export const execute = async (api) => ({ status: 'PASSED', steps: [], findings: [], keys: Object.keys(api).sort() });`,
      { granted: ['log'] },
    );
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).keys).toEqual(['baseUrl', 'log']);
  });

  it('forges a host call for a capability it never declared, and is refused', async () => {
    // The whole capability model rests on this. Plugin code can reach
    // parentPort directly, so the api object is not a boundary; the host's
    // grant check is. If this ever regresses, `onCall` gets invoked with
    // `secrets` for a plugin that declared only `log`.
    const onCall = vi.fn(async () => 'the-database-url');
    const outcome = await run(
      `import { parentPort } from 'node:worker_threads';
       export const execute = async () => {
         parentPort.postMessage({ type: 'call', id: 1, capability: 'secrets', method: 'get', args: ['DATABASE_URL'] });
         await new Promise(() => {});
       };`,
      { granted: ['log'], onCall },
    );

    expect(faultOf(outcome)).toBe('UNDECLARED_CAPABILITY');
    expect(onCall).not.toHaveBeenCalled();
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.fault.message).toMatch(/secrets/);
  });

  it('lets the host refuse one call without ending the run', async () => {
    // A plugin asking for a fixture it did not declare is a bug in the plugin,
    // not an attack: it sees a rejected promise and carries on. Only an
    // undeclared CAPABILITY is fatal.
    const outcome = await run(
      `export const execute = async (api) => {
         let caught = null;
         try { await api.fixtures.read('nope.json'); } catch (err) { caught = err.message; }
         return { status: 'PASSED', steps: [], findings: [], caught };
       };`,
      { granted: ['fixtures'], onCall: async () => { throw new Error('not declared'); } },
    );
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).caught).toBe('not declared');
  });

  it('stops a plugin that floods the bridge', async () => {
    const onCall = vi.fn(async () => null);
    const outcome = await run(
      `export const execute = async (api) => {
         for (let i = 0; i < 10000; i++) await api.log.line('x');
         return ${REPORT};
       };`,
      { granted: ['log'], onCall, limits: { maxHostCalls: 25 } },
    );
    expect(faultOf(outcome)).toBe('HOST_CALL_LIMIT');
    // 25 permitted plus the one that tripped the cap, and no more: proof the
    // counter stops the plugin rather than merely noticing afterwards.
    expect(onCall.mock.calls.length).toBeLessThanOrEqual(25);
  });
});

describe('failures in plugin code', () => {
  it('attributes a syntax error to load', async () => {
    expect(faultOf(await run('export const execute = async () => {'))).toBe('LOAD_ERROR');
  });

  it('attributes a throw at module scope to load', async () => {
    const outcome = await run(`throw new Error('boom at import'); export const execute = () => {};`);
    expect(faultOf(outcome)).toBe('LOAD_ERROR');
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.fault.message).toContain('boom at import');
  });

  it('refuses a module with no execute export', async () => {
    expect(faultOf(await run('export const run = async () => ({});'))).toBe('MISSING_ENTRY');
  });

  it('attributes a throw inside execute to the plugin, with its stack', async () => {
    const outcome = await run(
      `export const execute = async () => { throw new TypeError('cannot read x of undefined'); };`,
    );
    expect(faultOf(outcome)).toBe('THREW');
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.fault.message).toContain('cannot read x of undefined');
    expect(outcome.fault.stack).toContain('TypeError');
  });

  it('does not let a plugin relabel its own crash', async () => {
    // A forged kind must collapse to THREW. Otherwise a plugin could claim
    // CANCELLED and have the run stop blaming it for not producing a result.
    const outcome = await run(
      `import { parentPort } from 'node:worker_threads';
       export const execute = async () => {
         parentPort.postMessage({ type: 'fault', kind: 'CANCELLED', message: 'nothing to see here' });
         await new Promise(() => {});
       };`,
    );
    expect(faultOf(outcome)).toBe('THREW');
    if (outcome.ok) throw new Error('unreachable');
    expect(isPluginAtFault(outcome.fault)).toBe(true);
  });
});

describe('hard limits a plugin cannot exceed', () => {
  it('stops a plugin spinning in a loop that never yields', async () => {
    // The reason the sandbox is a worker at all. An in-process Promise.race
    // deadline would never fire here, because the timer callback needs the
    // event loop the plugin is holding.
    const started = Date.now();
    const outcome = await run(`export const execute = async () => { for (;;) {} };`, {
      limits: { wallClockMs: 400 },
    });
    expect(faultOf(outcome)).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('stops a plugin that simply never resolves', async () => {
    const outcome = await run(
      `export const execute = async () => new Promise(() => {});`,
      { limits: { wallClockMs: 400 } },
    );
    expect(faultOf(outcome)).toBe('TIMEOUT');
  });

  it('stops a plugin that grows the heap past its limit', async () => {
    const outcome = await run(
      `export const execute = async () => { const a = []; for (;;) a.push(new Array(1e6).fill(7)); };`,
      { limits: { memoryMb: 24, wallClockMs: 20_000 } },
    );
    expect(faultOf(outcome)).toBe('OUT_OF_MEMORY');
  }, 30_000);

  it('refuses a report too large to serialise, without flattening it', async () => {
    // Measured, not assumed: `'x'.repeat(300MB)` is a rope, so it slips past
    // the old-generation limit entirely, and JSON.stringify's flatten of it
    // aborts the PROCESS with a fatal heap error. Reaching the expect() below
    // is itself the assertion that the pre-serialisation size walk never read
    // the string.
    const outcome = await run(
      `export const execute = async () => ({ status: 'PASSED', steps: [], findings: [], blob: 'x'.repeat(300 * 1024 * 1024) });`,
      { limits: { memoryMb: 64, wallClockMs: 20_000 } },
    );
    expect(faultOf(outcome)).toBe('OUTPUT_TOO_LARGE');
  }, 30_000);

  it('refuses a report over the byte budget', async () => {
    const outcome = await run(
      `export const execute = async () => ({ status: 'PASSED', steps: [], findings: [], blob: 'y'.repeat(5000) });`,
      { limits: { maxOutputBytes: 4096 } },
    );
    expect(faultOf(outcome)).toBe('OUTPUT_TOO_LARGE');
  });

  it('accepts a report that fits', async () => {
    const outcome = await run(
      `export const execute = async () => ({ status: 'PASSED', steps: [], findings: [], blob: 'y'.repeat(100) });`,
      { limits: { maxOutputBytes: 4096 } },
    );
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).blob).toHaveLength(100);
    expect(outcome.usage.outputBytes).toBeGreaterThan(100);
  });

  it('refuses a cyclic report', async () => {
    const outcome = await run(
      `export const execute = async () => { const r = { status: 'PASSED', steps: [], findings: [] }; r.self = r; return r; };`,
    );
    expect(faultOf(outcome)).toBe('BAD_SHAPE');
  });

  it('refuses a report nested past the depth cap', async () => {
    const outcome = await run(
      `export const execute = async () => { let v = 1; for (let i = 0; i < 40; i++) v = { v }; return { status: 'PASSED', steps: [], findings: [], v }; };`,
    );
    expect(faultOf(outcome)).toBe('BAD_SHAPE');
  });

  it('refuses an oversized payload without decoding it', async () => {
    // A plugin can post its own `result` message and skip the bootstrap's
    // budget walk, so the host checks the buffer's byteLength before decoding.
    const outcome = await run(
      `import { parentPort } from 'node:worker_threads';
       export const execute = async () => {
         const bytes = new Uint8Array(200000);
         parentPort.postMessage({ type: 'result', len: 200000, bytes: bytes.buffer }, [bytes.buffer]);
         await new Promise(() => {});
       };`,
      { limits: { maxOutputBytes: 4096 } },
    );
    expect(faultOf(outcome)).toBe('OUTPUT_TOO_LARGE');
  });
});

describe('cancellation is not the plugin\'s fault', () => {
  it('reports CANCELLED, and says so', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const outcome = await run(`export const execute = async () => new Promise(() => {});`, {
      signal: controller.signal,
      limits: { wallClockMs: 10_000 },
    });
    expect(faultOf(outcome)).toBe('CANCELLED');
    if (outcome.ok) throw new Error('unreachable');
    expect(isPluginAtFault(outcome.fault)).toBe(false);
  });

  it('refuses to start at all on an already-aborted run', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(faultOf(await run(`export const execute = async () => (${REPORT});`, {
      signal: controller.signal,
    }))).toBe('CANCELLED');
  });
});

// ─── Pure units ──────────────────────────────────────────────────────────────

describe('classifyCapability', () => {
  it.each(MEDIATED_CAPABILITIES)('grants %s, which QAAI mediates', (name) => {
    expect(classifyCapability(name).granted).toBe(true);
  });

  it.each(['filesystem', 'network', 'process', 'env', 'child_process', 'browser', 'database'])(
    'refuses %s with a reason',
    (name) => {
      const decision = classifyCapability(name);
      expect(decision.granted).toBe(false);
      if (decision.granted) throw new Error('unreachable');
      expect(decision.reason.length).toBeGreaterThan(40);
    },
  );

  it('refuses a capability it has never heard of', () => {
    // Default-allow here would turn every future manifest field into a hole.
    expect(classifyCapability('telemetry').granted).toBe(false);
    expect(classifyCapability('').granted).toBe(false);
    expect(classifyCapability('__proto__').granted).toBe(false);
  });
});

describe('clampLimits', () => {
  it('lets a manifest ask for less', () => {
    expect(clampLimits({ wallClockMs: 5_000 }).wallClockMs).toBe(5_000);
  });

  it('refuses to let a manifest ask for more', () => {
    // The limits arrive inside the record the plugin author wrote, so they are
    // a request. Against the literal ceiling, not against DEFAULT_SANDBOX_LIMITS
    // read back out of the same module.
    const limits = clampLimits(
      { wallClockMs: 3_600_000, memoryMb: 8_192, maxFindings: 1_000_000 },
      { ...DEFAULT_SANDBOX_LIMITS, wallClockMs: 60_000, memoryMb: 128, maxFindings: 500 },
    );
    expect(limits.wallClockMs).toBe(60_000);
    expect(limits.memoryMb).toBe(128);
    expect(limits.maxFindings).toBe(500);
  });

  it('falls back to the ceiling on nonsense rather than to zero', () => {
    // A NaN that became a 0ms deadline would look exactly like a plugin that
    // always times out, and would be blamed on the plugin for weeks.
    const limits = clampLimits({ wallClockMs: Number.NaN, memoryMb: -1, maxSteps: 0 });
    expect(limits.wallClockMs).toBe(DEFAULT_SANDBOX_LIMITS.wallClockMs);
    expect(limits.memoryMb).toBe(DEFAULT_SANDBOX_LIMITS.memoryMb);
    expect(limits.maxSteps).toBe(DEFAULT_SANDBOX_LIMITS.maxSteps);
  });
});

describe('containmentTier', () => {
  it('reports isolate when Node has no permission model', () => {
    expect(containmentTier(undefined)).toBe('isolate');
  });

  it('reports isolate when the permission model denies nothing', () => {
    // `--permission` with everything allowed is the default surface wearing a
    // hat, and must not be reported as OS-level enforcement.
    expect(containmentTier({ has: () => true })).toBe('isolate');
  });

  it('reports isolate+os when it actually denies something', () => {
    expect(containmentTier({ has: (scope) => scope !== 'fs.write' })).toBe('isolate+os');
    expect(containmentTier({ has: (scope) => scope !== 'child' })).toBe('isolate+os');
  });
});

describe('the install screen and the sandbox agree on what a plugin may ask for', () => {
  /*
   * These were two lists. The manifest offered the raw capabilities a plugin
   * might want — network, page, filesystem, env, secrets, subprocess — and this
   * sandbox granted only what it can mediate. `secrets` was the sole overlap,
   * so an org could install a plugin declaring `network`, be told it was fine,
   * and watch it be refused on every run afterwards.
   *
   * There is one list now. This is the test that says so, because the failure
   * mode is silent: both halves keep working, they just disagree, and the
   * customer finds out at 3am.
   */
  it('grants exactly the capabilities the manifest can declare', () => {
    expect([...MEDIATED_CAPABILITIES].sort()).toEqual([...PLUGIN_CAPABILITIES].sort());
  });

  it('classifies every declarable capability as granted', () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      expect(classifyCapability(capability), capability).toMatchObject({ granted: true });
    }
  });

  it('refuses every raw capability the manifest can no longer declare, with a way forward', () => {
    // The old vocabulary. Each must be refused AND must name what to declare
    // instead — a refusal with no next step is a dead end at install time.
    for (const raw of ['network', 'page', 'filesystem', 'env', 'subprocess', 'process']) {
      const decision = classifyCapability(raw);
      expect(decision.granted, raw).toBe(false);
      if (!decision.granted) expect(decision.reason.length, raw).toBeGreaterThan(30);
    }
  });

  it('has copy for every capability it grants, or the install screen renders a blank row', () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      expect(PLUGIN_CAPABILITY_COPY[capability], capability).toBeTruthy();
    }
  });
});

// ─── Egress ──────────────────────────────────────────────────────────────────

describe('the mediated http capability is confined to the environment under test', () => {
  const BASE = 'https://staging.acme.test';

  /**
   * Runs a plugin that makes one `http` call and reports what came back, and
   * tells the test whether the host was ever asked to perform it.
   *
   * The `reached` flag is the assertion that matters. Checking only the error
   * the plugin saw would pass just as well if the request HAD been made and the
   * response merely withheld — and "the request was made" is the entire
   * vulnerability. `onCall` here stands in for the real mediation, which fetches.
   */
  async function attempt(
    url: string,
    baseUrl = BASE,
  ): Promise<{ outcome: SandboxOutcome; reached: string[] }> {
    const reached: string[] = [];
    const outcome = await run(
      `export const execute = async (api) => {
         let seen = null;
         try { seen = await api.http.request({ url: ${JSON.stringify(url)} }); }
         catch (err) { seen = 'REFUSED: ' + err.message; }
         return { status: 'PASSED', steps: [], findings: [], seen };
       };`,
      {
        granted: ['http'],
        baseUrl,
        onCall: async (call) => {
          const init = call.args[0] as { url?: string };
          reached.push(String(init?.url));
          return { status: 200, body: 'ok' };
        },
      },
    );
    return { outcome, reached };
  }

  it('lets the plugin reach the environment’s own origin', async () => {
    const { outcome, reached } = await attempt('/ping');
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(reached).toEqual(['/ping']);
    expect(JSON.parse(outcome.json).seen).toEqual({ status: 200, body: 'ok' });
  });

  it('reaches the environment even when it is loopback, because that is a local run', async () => {
    // The rule cannot be "refuse private addresses": every `npm run dev` run
    // points at 127.0.0.1, and a guard that broke those would be turned off.
    const { reached } = await attempt('/ping', 'http://127.0.0.1:3000');
    expect(reached).toEqual(['/ping']);
  });

  it.each([
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['a database port on loopback', 'http://127.0.0.1:5432/'],
    ['loopback by name', 'http://localhost:5432/'],
    ['an RFC1918 address', 'http://10.0.0.5/admin'],
    ['IPv6 loopback', 'http://[::1]:6379/'],
    ["EC2's IPv6 metadata endpoint", 'http://[fd00:ec2::254]/latest/'],
    ['IPv4-mapped IPv6', 'http://[::ffff:169.254.169.254]/'],
    ['the 6to4 encoding of it', 'http://[2002:a9fe:a9fe::]/'],
    ['the octal encoding of loopback', 'http://0177.0.0.1/'],
    ['the decimal encoding of loopback', 'http://2130706433/'],
    ['the hex encoding of loopback', 'http://0x7f.0.0.1/'],
    ['a cluster-internal name', 'http://kubernetes.default.svc/api'],
    ['a single-label service name', 'http://redis/'],
    ['a trailing-dot bypass of the name list', 'http://localhost./'],
    /*
     * The three encoded forms are in this list for the behaviour, not because
     * `classifyHost`'s ambiguity branch is what catches them here: `new URL()`
     * normalises `0177.0.0.1`, `2130706433` and `0x7f.0.0.1` to `127.0.0.1`
     * before the guard sees a hostname at all. They stay because that
     * normalisation is a property of Node's parser rather than of this file,
     * and the day it changes this is the test that says so.
     */
  ])('ends the run rather than requesting %s', async (_label, url) => {
    const { outcome, reached } = await attempt(url);
    // Nothing was asked of the host: the refusal is upstream of the fetch.
    expect(reached).toEqual([]);
    expect(faultOf(outcome)).toBe('EGRESS_REFUSED');
  });

  it('refuses an off-origin public destination without ending the run', async () => {
    // Exfiltration, not a network probe: the plugin wanted to POST somewhere it
    // chose. It is a bug in the plugin, so the plugin observes it and carries on
    // — the same treatment an undeclared fixture gets.
    const { outcome, reached } = await attempt('https://collector.example.com/x');
    expect(reached).toEqual([]);
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).seen).toContain('collector.example.com');
  });

  it('refuses a scheme that is not http or https', async () => {
    const { outcome, reached } = await attempt('file:///etc/passwd');
    expect(reached).toEqual([]);
    if (!outcome.ok) throw new Error(faultOf(outcome));
    expect(JSON.parse(outcome.json).seen).toContain('"file:" is not an allowed scheme');
  });

  it('refuses the next hop of a redirect that starts public and lands private', async () => {
    /*
     * Nobody follows redirects for the plugin — the host fetches with
     * `redirect: 'manual'` — so the second hop is a second `http` call, and it
     * arrives at the same guard. This is that call: the plugin read a Location
     * header off a 302 and asked for it.
     */
    const { outcome, reached } = await attempt('http://169.254.169.254/latest/meta-data/iam/');
    expect(reached).toEqual([]);
    expect(faultOf(outcome)).toBe('EGRESS_REFUSED');
  });

  it('is not fooled by a same-host request on a different port', async () => {
    // Origin is scheme, host AND port. The app under test being on :443 says
    // nothing about what else that machine is listening on.
    const { outcome, reached } = await attempt('https://staging.acme.test:9200/_cat/indices');
    expect(reached).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('is enforced even when the plugin forges the host call itself', async () => {
    /*
     * The `api.http` object the bootstrap builds is a convenience. Plugin code
     * can import node:worker_threads and post the message itself, which is
     * exactly what this does — if the guard lived in that object rather than on
     * the host side of the port, it would be decoration.
     */
    const reached: string[] = [];
    const outcome = await run(
      `import { parentPort } from 'node:worker_threads';
       export const execute = async () => {
         parentPort.postMessage({ type: 'call', id: 99, capability: 'http', method: 'request',
                                  args: [{ url: 'http://169.254.169.254/' }] });
         await new Promise((r) => setTimeout(r, 3000));
         return { status: 'PASSED', steps: [], findings: [] };
       };`,
      {
        granted: ['http'],
        baseUrl: BASE,
        onCall: async (call) => {
          reached.push(String((call.args[0] as { url?: string })?.url));
          return null;
        },
      },
    );
    expect(reached).toEqual([]);
    expect(faultOf(outcome)).toBe('EGRESS_REFUSED');
  });
});

describe('checkHttpDestination', () => {
  const BASE = 'https://staging.acme.test';

  it('allows only the environment’s exact origin', () => {
    expect(checkHttpDestination('/a', BASE)).toEqual({
      verdict: 'allow',
      url: 'https://staging.acme.test/a',
    });
    expect(checkHttpDestination('https://staging.acme.test/a?b=1', BASE).verdict).toBe('allow');
    expect(checkHttpDestination('http://staging.acme.test/a', BASE).verdict).toBe('refuse');
    expect(checkHttpDestination('https://staging.acme.test:8080/a', BASE).verdict).toBe('refuse');
    expect(checkHttpDestination('https://evil.staging.acme.test/a', BASE).verdict).toBe('refuse');
  });

  it('refuses everything when the environment has no usable URL', () => {
    // Fail closed: an unparseable baseUrl must grant nothing, not everything.
    expect(checkHttpDestination('https://anywhere.example.com/', 'not a url').verdict).toBe(
      'refuse',
    );
    expect(checkHttpDestination('/a', '').verdict).toBe('refuse');
  });

  it('refuses a URL carrying embedded credentials', () => {
    expect(checkHttpDestination('https://u:p@staging.acme.test/a', BASE).verdict).toBe('refuse');
  });

  it('refuses a non-string url without throwing', () => {
    expect(checkHttpDestination(undefined, BASE).verdict).toBe('refuse');
    expect(checkHttpDestination({ toString: () => '/a' }, BASE).verdict).toBe('refuse');
  });

  it('calls an address inside our network a probe and an ordinary origin a refusal', () => {
    // The distinction the fault kinds rest on: one ends the run, the other does
    // not, and the difference is whether QAAI's network position was the point.
    expect(checkHttpDestination('http://169.254.169.254/', BASE).verdict).toBe('probe');
    expect(checkHttpDestination('https://collector.example.com/', BASE).verdict).toBe('refuse');
  });

  it('names the class of the address it refused, so the fault is actionable', () => {
    const verdict = checkHttpDestination('http://169.254.169.254/', BASE);
    if (verdict.verdict !== 'probe') throw new Error('expected a probe');
    expect(verdict.reason).toContain('link-local');
  });
});

describe('runInSandbox never rejects, whatever it is handed', () => {
  /*
   * This is the attribution guarantee, and it is a guarantee about the RETURN
   * TYPE. `executeExternal` converts a fault into a SKIPPED execution that says
   * the plugin broke; a REJECTION propagates out of the plugin's `execute()`
   * and apps/worker/src/processors/run.ts records it as the customer's
   * application failing. "Your checkout is broken, because a plugin's spec had
   * a function in it" is the worst thing this feature can print.
   */
  it('returns a fault when the isolate cannot be started at all', async () => {
    // `new Worker(...)` runs synchronously, outside the promise, and clones
    // workerData: a spec carrying anything structured-clone cannot copy throws
    // DataCloneError before the isolate exists.
    const outcome = await run(`export const execute = async () => ({ status: 'PASSED' });`, {
      spec: { probe: () => 1 },
    });
    expect(faultOf(outcome)).toBe('CRASHED');
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.fault.message).toContain('could not be started');
    // Still the plugin's fault, never the application's.
    expect(isPluginAtFault(outcome.fault)).toBe(true);
  });
});
