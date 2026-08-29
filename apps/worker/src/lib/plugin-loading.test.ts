/**
 * Does a run actually look at the plugin registry, and does it look correctly?
 *
 * The bug this file exists for is not "the loader is wrong". The loader was
 * fine. The bug was that NOTHING CALLED IT: outside the settings endpoint that
 * writes them, no code in the repository read `plugin`, `pluginEnablement` or
 * `pluginPublisher`, so an org could trust a publisher, install a signed
 * plugin, enable it on a project, and every run would proceed as if none of it
 * had happened.
 *
 * So the load-bearing test here is the last one, and it is deliberately an
 * integration test through `processRun` rather than a unit test of this module:
 * a unit test of `loadProjectPlugins` passes perfectly well while the run
 * processor never calls it, which is precisely the state the last wave shipped.
 * Delete the call from run.ts and that test goes red; nothing else in the repo
 * does.
 *
 * The rest divide into three properties the feature was sold on:
 *
 *   SCOPING       only plugins enabled for THAT project in THAT org load. Four
 *                 filters, four tests, one per way of getting it wrong.
 *   VERIFICATION  the manifest and signature are stored verbatim so they can be
 *                 re-checked here, away from the endpoint that accepted them.
 *                 Real Ed25519 keys, real signatures, real tampering.
 *   ATTRIBUTION   a plugin that cannot run is reported as a plugin fault, the
 *                 run proceeds, and the customer's application is not blamed.
 */

import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShardedRunJob } from '@qaai/shared';
import {
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_PROTOCOL_VERSION,
  bundleDigest,
  manifestSigningInput,
} from '../../../../packages/shared/src/plugin-manifest.js';
import type { PluginManifest } from '../../../../packages/shared/src/plugin-manifest.js';

// ─── The worker's world, replaced ────────────────────────────────────────────

const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    published: Array<{ type: string; data: Record<string, unknown> }>;
    executed: string[];
    log: string[];
    /** Test types `pluginFor` should answer null for, so the fallback is reachable. */
    unimplemented: Set<string>;
  } => ({ prisma: {}, published: [], executed: [], log: [], unimplemented: new Set() }),
);

vi.mock('../context.js', () => ({
  config: { concurrency: 2, artifactsLocal: true, anthropicApiKey: 'test' },
  connection: { disconnect: () => {} },
  logger: {
    debug: () => {},
    info: (_o: unknown, msg?: string) => h.log.push(`info:${msg ?? ''}`),
    warn: (_o: unknown, msg?: string) => h.log.push(`warn:${msg ?? ''}`),
    error: (_o: unknown, msg?: string) => h.log.push(`error:${msg ?? ''}`),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  publishEvent: (_orgId: string, event: { type: string; data: Record<string, unknown> }) => {
    h.published.push({ type: event.type, data: event.data });
  },
  storage: { put: async () => {}, putFile: async () => {}, get: async () => null },
}));

vi.mock('../queues.js', () => ({
  ANALYZE_SOURCE_QUEUE: 'qaai.analyze-source',
  DELIVERY_JOB: 'delivery',
  enqueueNotify: async () => {},
  enqueueTriage: async () => {},
}));

vi.mock('../vault.js', () => ({ secretsFor: async () => ({}), open: () => 'access-key' }));
vi.mock('../grids.js', () => ({ gridWsEndpoint: () => 'wss://grid.example/ws' }));
vi.mock('@qaai/storage', () => ({
  artifactKey: (a: { orgId: string; runId: string; name: string }) =>
    `orgs/${a.orgId}/runs/${a.runId}/${a.name}`,
}));
vi.mock('../processors/schedule.js', () => ({
  recordMonitorResult: async () => {},
  processScheduleTick: async () => {},
}));

/**
 * The FIRST-PARTY plugin, standing in for all nineteen of them.
 *
 * `pluginFor` consults `h.unimplemented` so a test can ask what happens for a
 * type QAAI does not implement — which is the only circumstance under which an
 * installed plugin could ever be reached, and therefore the only circumstance
 * in which the resolution order is observable at all.
 */
const firstParty = {
  type: 'E2E',
  validate: () => {},
  execute: async (_ctx: unknown, test: { id: string }) => {
    h.executed.push(test.id);
    return {
      testId: test.id,
      status: 'PASSED' as const,
      durationMs: 10,
      steps: [],
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      errorMessage: null,
      retriedAndPassed: false,
      findings: [],
    };
  },
};

vi.mock('@qaai/runner', () => ({
  DEFAULT_GATE_RULES: [],
  evaluateGates: () => ({ passed: true, evaluations: [] }),
  reasonUnsupported: (type: string) => `${type} is not supported`,
  pluginFor: (type: string) => (h.unimplemented.has(type) ? null : firstParty),
}));

const { admitPlugin, loadProjectPlugins, resolveTestPlugin } = await import('./plugin-loading.js');
type EnabledPluginRow = import('./plugin-loading.js').EnabledPluginRow;
type ProjectPlugins = import('./plugin-loading.js').ProjectPlugins;
const { processRun } = await import('../processors/run.js');

// ─── Keys, manifests, rows ───────────────────────────────────────────────────

function keypair(): { privateKey: KeyObject; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, raw: spki.subarray(spki.length - 32) };
}

const acme = keypair();
const impostor = keypair();

const BUNDLE = Buffer.from('export const execute = async () => ({ status: "PASSED" });\n', 'utf8');
const BUNDLE_SHA = bundleDigest(BUNDLE);

const ORG = 'org1';
const OTHER_ORG = 'org2';
const PROJECT = 'proj1';

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schema: PLUGIN_MANIFEST_SCHEMA,
    name: 'acme-lighthouse',
    version: '1.4.2',
    publisher: 'acme',
    displayName: 'Acme Lighthouse',
    description: 'Runs Lighthouse against every page the suite visits.',
    protocol: PLUGIN_PROTOCOL_VERSION,
    capabilities: ['http'],
    code: { sha256: BUNDLE_SHA, bytes: BUNDLE.length, entry: 'dist/index.js' },
    ...over,
  };
}

interface RowOptions {
  /** The manifest STORED on the row. */
  manifest?: PluginManifest;
  /** The manifest that was SIGNED, when a test wants the two to differ. */
  signed?: PluginManifest;
  key?: KeyObject;
  orgId?: string;
  projectId?: string;
  enabled?: boolean;
  plugin?: Partial<EnabledPluginRow['plugin']>;
  publisherRow?: Partial<NonNullable<EnabledPluginRow['plugin']['publisherRow']>> | null;
}

/** One row exactly as `ENABLED_PLUGIN_SELECT` would return it, signed for real. */
function enabledRow(opts: RowOptions = {}): EnabledPluginRow & { enabled: boolean } {
  const stored = opts.manifest ?? manifest();
  const signed = opts.signed ?? stored;
  const orgId = opts.orgId ?? ORG;
  return {
    orgId,
    projectId: opts.projectId ?? PROJECT,
    enabled: opts.enabled ?? true,
    plugin: {
      id: 'plg_1',
      orgId,
      name: stored.name,
      version: stored.version,
      publisher: stored.publisher,
      protocol: stored.protocol,
      capabilities: [...stored.capabilities],
      codeSha256: stored.code.sha256,
      codeBytes: stored.code.bytes,
      codeEntry: stored.code.entry,
      manifest: stored,
      signature: signBytes(
        null,
        manifestSigningInput(signed),
        opts.key ?? acme.privateKey,
      ).toString('base64'),
      publisherRow:
        opts.publisherRow === null
          ? null
          : {
              orgId,
              publisherId: 'acme',
              publicKey: acme.raw.toString('base64'),
              revokedAt: null,
              ...opts.publisherRow,
            },
      ...opts.plugin,
    },
  };
}

// ─── Resolution: a first-party type cannot be shadowed ───────────────────────

describe('resolving a test type to a plugin', () => {
  const shadow = {
    type: 'E2E',
    validate: () => {},
    execute: async () => {
      throw new Error('the installed plugin must never be reached for E2E');
    },
  } as unknown as import('@qaai/shared').RunnerPlugin;

  function withShadow(type: string): ProjectPlugins {
    return {
      byType: new Map([[type as import('@qaai/shared').TestType, shadow]]),
      admissions: [],
    };
  }

  it('returns the first-party plugin even when an installed one claims the type', () => {
    // The whole point. `pluginFor` is asked FIRST and the installed map is not
    // consulted at all for a type QAAI implements, so no arrangement of
    // registry rows can put third-party code in front of the E2E plugin.
    expect(resolveTestPlugin('E2E', withShadow('E2E'))).toBe(firstParty);
  });

  it('falls back to an installed plugin only for a type QAAI does not implement', () => {
    // The counter-test. Without it, "first party wins" would be satisfied by a
    // function that always returns the first-party plugin and never resolves
    // anything else — which would make the ordering untestable rather than
    // correct.
    h.unimplemented.add('LOAD');
    expect(resolveTestPlugin('LOAD', withShadow('LOAD'))).toBe(shadow);
  });

  it('returns null when neither has one', () => {
    h.unimplemented.add('LOAD');
    expect(resolveTestPlugin('LOAD', { byType: new Map(), admissions: [] })).toBeNull();
  });
});

// ─── Scoping ─────────────────────────────────────────────────────────────────

/**
 * A `pluginEnablement.findMany` that honours the `where` it is given.
 *
 * A fake that ignored the filter would make all four scoping tests pass against
 * a query with no filter at all, which is the exact regression they exist to
 * catch. The nested `plugin: { orgId }` is applied too, because that is the one
 * filter no other layer supplies: the worker's Prisma client carries no tenancy
 * extension.
 */
function registryOf(rows: Array<EnabledPluginRow & { enabled: boolean }>) {
  return {
    pluginEnablement: {
      findMany: async (args: {
        where: {
          orgId: string;
          projectId: string;
          enabled: boolean;
          plugin: { orgId: string };
        };
      }) => rows.filter((row) => matchesWhere(row, args.where)),
    },
  };
}

/**
 * Prisma's `undefined` semantics, faithfully: a `where` key whose value is
 * `undefined` is not an impossible filter, it is an ABSENT one, and every row
 * matches. Without that, dropping a filter would make this fake return nothing
 * and the scoping tests would go red for the opposite of the real reason.
 */
function matchesWhere(
  row: EnabledPluginRow & { enabled: boolean },
  where: {
    orgId?: string;
    projectId?: string;
    enabled?: boolean;
    plugin?: { orgId?: string };
  },
): boolean {
  if (where.orgId !== undefined && row.orgId !== where.orgId) return false;
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
  if (where.enabled !== undefined && row.enabled !== where.enabled) return false;
  if (where.plugin?.orgId !== undefined && row.plugin.orgId !== where.plugin.orgId) return false;
  return true;
}

describe('only plugins enabled for that project, in that org, are loaded', () => {
  const mine = enabledRow();

  it.each([
    ['another org’s enablement row', enabledRow({ orgId: OTHER_ORG })],
    ['another project in the same org', enabledRow({ projectId: 'proj2' })],
    ['a row that says enabled: false', enabledRow({ enabled: false })],
    [
      'a row pointing at another org’s plugin',
      enabledRow({ plugin: { orgId: OTHER_ORG } }),
    ],
  ])('does not load %s', async (_label, stranger) => {
    const loaded = await loadProjectPlugins(registryOf([mine, stranger]), {
      orgId: ORG,
      projectId: PROJECT,
    });
    expect(loaded.admissions).toHaveLength(1);
    expect(loaded.admissions[0]?.label).toBe('acme-lighthouse@1.4.2');
  });

  it('loads nothing, and says nothing, when the project has no plugins', async () => {
    const loaded = await loadProjectPlugins(registryOf([]), { orgId: ORG, projectId: PROJECT });
    expect(loaded.admissions).toEqual([]);
    expect(loaded.byType.size).toBe(0);
  });

  it('reports a registry that cannot be read, and does not throw', async () => {
    // A database blip in a feature the customer may not even use must not be
    // able to turn their suite red.
    const broken = {
      pluginEnablement: {
        findMany: async () => {
          throw new Error('connection terminated');
        },
      },
    };
    const loaded = await loadProjectPlugins(broken, { orgId: ORG, projectId: PROJECT });
    expect(loaded.admissions[0]?.fault?.message).toContain('connection terminated');
    expect(loaded.admissions[0]?.fault?.message).toContain('The suite itself was not affected');
  });
});

// ─── Verification ────────────────────────────────────────────────────────────

describe('an enabled plugin is re-verified before it could ever run', () => {
  it('refuses a manifest row edited after it was installed', async () => {
    // The install verified the signature; this row was changed afterwards. The
    // signature is stored verbatim precisely so this is catchable, and the
    // point of catching it HERE is that the endpoint that accepted the plugin
    // will never look at it again.
    const tampered = manifest({ description: 'Now also reads your production database.' });
    const admission = admitPlugin(enabledRow({ manifest: tampered, signed: manifest() }));
    expect(admission.fault?.message).toContain('no longer verifies');
    expect(admission.fault?.message).toContain('Nothing was executed');
  });

  it('refuses a manifest signed by a key this org never trusted', () => {
    const admission = admitPlugin(enabledRow({ key: impostor.privateKey }));
    expect(admission.fault?.message).toContain('no longer verifies');
  });

  it('refuses a plugin whose publisher key has since been revoked', () => {
    // Revoking a key deliberately does NOT uninstall what was signed with it
    // (apps/api/src/routes/plugins.ts) — so the run is where that decision has
    // to bite, or revocation stops nothing that is already enabled.
    const admission = admitPlugin(
      enabledRow({ publisherRow: { revokedAt: new Date('2026-02-11T00:00:00Z') } }),
    );
    expect(admission.fault?.message).toContain('revoked on 2026-02-11');
    expect(admission.fault?.message).toContain('Nothing was executed');
  });

  it('refuses when the signed digest and the stored column disagree', () => {
    // Two values claiming to be "the content hash". When they differ there is
    // no digest to verify bytes against, and choosing one is how verification
    // starts passing on everything.
    const admission = admitPlugin(
      enabledRow({ plugin: { codeSha256: bundleDigest(Buffer.from('something else')) } }),
    );
    expect(admission.fault?.kind).toBe('HASH_MISMATCH');
    expect(admission.fault?.message).toContain('disagree');
  });

  it('refuses a plugin whose publisher row belongs to another org', () => {
    const admission = admitPlugin(enabledRow({ publisherRow: { orgId: OTHER_ORG } }));
    expect(admission.fault?.message).toContain('does not own it');
  });

  it('refuses a plugin with no publisher row at all', () => {
    const admission = admitPlugin(enabledRow({ publisherRow: null }));
    expect(admission.fault?.message).toContain('no publisher row');
  });

  it('refuses a name QAAI reserves for its own plugins, even properly signed', () => {
    // The install path refuses this too. It is refused again here because THIS
    // is the moment a name would decide which code answers for a test type,
    // and a row can reach the table by means other than that endpoint.
    const admission = admitPlugin(enabledRow({ manifest: manifest({ name: 'e2e' }) }));
    expect(admission.fault?.message).toContain('reserves');
  });

  it('refuses a build targeting a protocol this worker does not speak', () => {
    const admission = admitPlugin(
      enabledRow({ manifest: manifest({ protocol: PLUGIN_PROTOCOL_VERSION + 1 }) }),
    );
    expect(admission.fault?.message).toContain(`protocol ${PLUGIN_PROTOCOL_VERSION + 1}`);
  });

  it('refuses a row whose columns have drifted from the signed manifest', () => {
    const admission = admitPlugin(enabledRow({ plugin: { version: '9.9.9' } }));
    expect(admission.fault?.message).toContain('drifted');
  });

  it('refuses a manifest that is no longer a valid document', () => {
    const admission = admitPlugin(enabledRow({ plugin: { manifest: { schema: 'nope' } } }));
    expect(admission.fault?.kind).toBe('BAD_SHAPE');
  });
});

describe('a plugin that verifies perfectly is still refused, and says exactly why', () => {
  /*
   * The honest half. Everything about this plugin checks out — trusted
   * publisher, valid signature, matching digests, supported protocol — and QAAI
   * still cannot run it, because the registry stores a DESCRIPTION of a bundle
   * and never the bundle, and because a `qaai.plugin/1` manifest has no field
   * naming a test type. Both are schema changes.
   *
   * The message is asserted almost in full on purpose. It is the only thing the
   * customer will see, it has to leave them not hunting a signing problem, and
   * it has to take the blame rather than leaving them to conclude their vendor
   * shipped something broken.
   */
  const admission = admitPlugin(enabledRow());

  it('does not admit it', () => {
    expect(admission.fault).not.toBeNull();
    expect(admission.fault?.kind).toBe('MISSING_ENTRY');
  });

  it('says the signature verified, so nobody goes looking for a signing bug', () => {
    expect(admission.fault?.message).toContain('its signature verifies under "acme"');
  });

  it('names both missing things', () => {
    expect(admission.fault?.message).toContain('no bundle bytes and no location to fetch');
    expect(admission.fault?.message).toContain('dist/index.js');
    expect(admission.fault?.message).toContain('names no test type');
  });

  it('takes the blame instead of leaving it on the publisher', () => {
    expect(admission.fault?.message).toContain(
      'This is a gap in QAAI, not a fault in acme-lighthouse@1.4.2',
    );
  });

  it('is never put into the map a run routes tests through', async () => {
    // The map is what `resolveTestPlugin` consults. A refused plugin reaching
    // it would make the refusal decorative — the sentence would be published
    // and the code would run anyway.
    const loaded = await loadProjectPlugins(registryOf([enabledRow()]), {
      orgId: ORG,
      projectId: PROJECT,
    });
    expect(loaded.admissions).toHaveLength(1);
    expect(loaded.admissions[0]?.fault?.kind).toBe('MISSING_ENTRY');
    expect(loaded.byType.size).toBe(0);
  });
});

// ─── The loop this wave exists to close ──────────────────────────────────────

interface ResultRow {
  id: string;
  testId: string;
  shardIndex: number | null;
  status: string;
  retriedAndPassed: boolean;
  durationMs: number;
  test: Record<string, unknown>;
}

function fakeWorld(rows: Array<EnabledPluginRow & { enabled: boolean }>): {
  run: Record<string, unknown>;
  enablementQueries: unknown[];
} {
  const run: Record<string, unknown> = {
    id: 'run1',
    orgId: ORG,
    projectId: PROJECT,
    status: 'QUEUED',
    trigger: 'MANUAL',
    prNumber: null,
    startedAt: null,
    finishedAt: null,
    finalizedAt: null,
    totalCount: 1,
    shardCount: 1,
    baseUrlOverride: null,
    passedCount: 0,
    failedCount: 0,
    flakyCount: 0,
    skippedCount: 0,
    gateResult: null,
    errorMessage: null,
  };
  const results: ResultRow[] = [
    {
      id: 'r1',
      testId: 't1',
      shardIndex: null,
      status: 'SKIPPED',
      retriedAndPassed: false,
      durationMs: 0,
      test: {
        id: 't1',
        name: 'checkout',
        type: 'E2E',
        code: 'await page.goto("/")',
        filePath: 'tests/checkout.spec.ts',
        spec: null,
        timeoutMs: 30_000,
        quarantined: false,
        tags: [],
        priority: 'IMPORTANT',
        consecutiveFailures: 0,
      },
    },
  ];
  const enablementQueries: unknown[] = [];

  const resultModel = {
    findMany: async () =>
      results.map((r) => ({ ...r, test: { name: 'checkout', priority: 'IMPORTANT', quarantined: false }, verdict: null })),
    groupBy: async () => [{ status: 'PASSED', _count: { _all: 1 } }],
    update: async (args: { where: { id: string }; data: { status?: string } }) => {
      const row = results.find((r) => r.id === args.where.id);
      if (row && args.data.status) row.status = args.data.status;
      return {};
    },
  };
  const tx = {
    testResult: resultModel,
    step: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    finding: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    artifact: { upsert: async () => ({}) },
  };

  h.prisma = {
    run: {
      findFirst: async () => ({
        ...run,
        environment: { id: 'env1', baseUrl: 'https://staging.example.com' },
        project: { id: PROJECT, gateRules: [] },
        results,
      }),
      findUnique: async () => ({ ...run }),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        Object.assign(run, args.data);
        return { count: 1 };
      },
      update: async (args: { data: Record<string, unknown> }) => {
        Object.assign(run, args.data);
        return { ...run };
      },
    },
    testResult: resultModel,
    organization: { findUniqueOrThrow: async () => ({ plan: 'TEAM' }) },
    test: {
      findMany: async () => [],
      findUnique: async () => ({ consecutiveFailures: 0 }),
      update: async () => ({}),
    },
    integration: { findFirst: async () => null },
    authProfile: { findFirst: async () => null },
    visualBaseline: { findFirst: async () => null, upsert: async () => ({}) },
    runShard: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    pluginEnablement: {
      findMany: async (args: unknown) => {
        enablementQueries.push(args);
        const where = (args as { where: Parameters<typeof matchesWhere>[1] }).where;
        return rows.filter((row) => matchesWhere(row, where));
      },
    },
    $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };

  return { run, enablementQueries };
}

const job: ShardedRunJob = { orgId: ORG, runId: 'run1' };

beforeEach(() => {
  h.published = [];
  h.executed = [];
  h.log = [];
  h.unimplemented = new Set();
});

describe('a run reads the registry, and a broken plugin does not break the run', () => {
  it('asks for the plugins enabled on THIS run’s project, in THIS run’s org', async () => {
    // The assertion the whole wave turns on. Before this, no run asked at all.
    const world = fakeWorld([enabledRow()]);
    await processRun(job);
    expect(world.enablementQueries).toHaveLength(1);
    expect(world.enablementQueries[0]).toMatchObject({
      where: { orgId: ORG, projectId: PROJECT, enabled: true, plugin: { orgId: ORG } },
    });
  });

  it('asks for the manifest and the signature, because that is what it re-checks', async () => {
    const world = fakeWorld([enabledRow()]);
    await processRun(job);
    const select = (world.enablementQueries[0] as { select: { plugin: { select: Record<string, unknown> } } })
      .select.plugin.select;
    expect(select.manifest).toBe(true);
    expect(select.signature).toBe(true);
    expect(select.publisherRow).toBeTruthy();
  });

  it('reports the plugin fault on its own event, naming the plugin', async () => {
    fakeWorld([enabledRow()]);
    await processRun(job);
    const faults = h.published.filter((e) => e.type === 'plugin.fault');
    expect(faults).toHaveLength(1);
    expect(faults[0]?.data).toMatchObject({ plugin: 'acme-lighthouse@1.4.2', publisher: 'acme' });
    expect(String(faults[0]?.data.message)).toContain('gap in QAAI');
  });

  it('runs the suite anyway, and finishes the run cleanly', async () => {
    // The rule the feature rests on: somebody else's plugin cannot be the
    // reason a customer's tests do not run, or the reason a merge is blocked.
    const world = fakeWorld([enabledRow()]);
    await processRun(job);
    expect(h.executed).toEqual(['t1']);
    expect(world.run.status).toBe('PASSED');
    expect(world.run.errorMessage).toBeNull();
  });

  it('publishes nothing about plugins when the project has none enabled', async () => {
    fakeWorld([]);
    await processRun(job);
    expect(h.published.filter((e) => e.type === 'plugin.fault')).toEqual([]);
    expect(h.executed).toEqual(['t1']);
  });

  it('survives a registry that cannot be read at all', async () => {
    // run.ts's own test suite exercises this path incidentally: its prisma fake
    // has no plugin models, so the read throws. It must cost the run nothing.
    fakeWorld([]);
    (h.prisma.pluginEnablement as { findMany: unknown }).findMany = async () => {
      throw new Error('relation "PluginEnablement" does not exist');
    };
    await processRun(job);
    expect(h.executed).toEqual(['t1']);
    const faults = h.published.filter((e) => e.type === 'plugin.fault');
    expect(String(faults[0]?.data.message)).toContain('does not exist');
  });
});
