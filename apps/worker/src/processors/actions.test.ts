/**
 * Event actions (§7) — dispatcher and egress policy.
 *
 * Two things are under test here, and they fail in very different ways.
 *
 * THE EGRESS POLICY is the one that matters. An action fires an outbound
 * request to a URL a customer chose, from inside our network, so the tests
 * below are written as attacks rather than as cases: the cloud metadata service
 * by literal, by IPv4-mapped IPv6, by 6to4, by NAT64, by unique-local, and by a
 * hostname that resolves to it. Every one of them must be refused, recorded and
 * never attempted. A test here that goes green when the code is wrong is worse
 * than no test, so nothing asserts against a second call into the module — the
 * expected classification is spelled out in the test.
 *
 * THE DISPATCHER's contract is isolation and org scoping: one broken action
 * costs only its own delivery, an action only ever hears what it subscribed to,
 * a broadly-subscribed action hears one event and not three, and every database
 * read carries the job's orgId. The org-scoping assertions inspect the actual
 * `where` clause the processor sent, because a query that forgot `orgId` still
 * returns rows in a unit test — it only leaks in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkChatDestination } from '../../../api/src/lib/chat-integrations.js';

const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    log: Array<{ level: string; msg: string; obj: unknown }>;
    delivered: unknown[];
    queued: Array<{ queue: string; data: unknown; opts: Record<string, unknown> }>;
  } => ({ prisma: {}, log: [], delivered: [], queued: [] }),
);

// The worker's context opens Postgres, Redis and the LLM at import time.
vi.mock('../context.js', () => ({
  config: { concurrency: 1 },
  connection: {},
  logger: {
    debug: () => {},
    info: (obj: unknown, msg?: string) => h.log.push({ level: 'info', msg: msg ?? '', obj }),
    warn: (obj: unknown, msg?: string) => h.log.push({ level: 'warn', msg: msg ?? '', obj }),
    error: (obj: unknown, msg?: string) => h.log.push({ level: 'error', msg: msg ?? '', obj }),
  },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
}));

// The producer half is plumbing; these tests care WHAT was handed to it.
vi.mock('../queues.js', () => ({
  enqueueDelivery: async (job: unknown) => {
    h.delivered.push(job);
  },
}));

// Unwraps anything sealed by `sealed()` below and fails closed on the rest —
// the same two outcomes the real AES-GCM open has.
vi.mock('../vault.js', () => ({
  open: (enc: string): string => {
    if (enc.startsWith('sealed:')) return enc.slice('sealed:'.length);
    throw new Error('wrong key version');
  },
}));

// The module builds its producer lazily, but `dispatchActionsForNotify` still
// reaches it. A stand-in Queue keeps the test off Redis and records the job id,
// which is the deduplication contract for the enqueue half.
vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public readonly queueName: string) {}
    async add(_name: string, data: unknown, opts: Record<string, unknown>): Promise<void> {
      h.queued.push({ queue: this.queueName, data, opts });
    }
    async close(): Promise<void> {}
  },
}));

const {
  MAX_ACTIONS_PER_EVENT,
  actionJobsFromNotify,
  checkActionDestination,
  classifyAddress,
  classifyIpv4,
  classifyIpv6,
  dispatchActionsForNotify,
  expandIpv6,
  processActionEvent,
  resolveIsPublic,
} = await import('./actions.js');

const { decodeActionEventBody } = await import(
  '../../../../packages/shared/src/action-events.js'
);

beforeEach(() => {
  h.prisma = {};
  h.log = [];
  h.delivered = [];
  h.queued = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Address classification
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyIpv4', () => {
  it('names the cloud metadata service as link-local', () => {
    // 169.254.169.254 is the same address on AWS, GCP and Azure, and it is the
    // first thing anybody points a customer-controlled URL at.
    expect(classifyIpv4('169.254.169.254')).toBe('link-local');
  });

  it('classifies the ranges that are not the internet', () => {
    expect(classifyIpv4('127.0.0.1')).toBe('loopback');
    expect(classifyIpv4('10.1.2.3')).toBe('private');
    expect(classifyIpv4('172.16.0.1')).toBe('private');
    expect(classifyIpv4('172.31.255.254')).toBe('private');
    expect(classifyIpv4('192.168.1.1')).toBe('private');
    expect(classifyIpv4('100.64.0.1')).toBe('private');
    expect(classifyIpv4('0.0.0.0')).toBe('unspecified');
    expect(classifyIpv4('224.0.0.1')).toBe('multicast');
    expect(classifyIpv4('255.255.255.255')).toBe('reserved');
    expect(classifyIpv4('198.18.0.1')).toBe('reserved');
  });

  it('does not over-reach into the neighbouring public ranges', () => {
    // The boundary cases: an off-by-one here refuses a legitimate destination
    // forever, which is the other way this function can be wrong.
    expect(classifyIpv4('172.15.255.255')).toBe('public');
    expect(classifyIpv4('172.32.0.1')).toBe('public');
    expect(classifyIpv4('100.63.255.255')).toBe('public');
    expect(classifyIpv4('100.128.0.1')).toBe('public');
    expect(classifyIpv4('8.8.8.8')).toBe('public');
    expect(classifyIpv4('169.253.0.1')).toBe('public');
  });

  it('refuses an ambiguous literal rather than picking a reading', () => {
    // `0177.0.0.1` is 127.0.0.1 to a parser that honours octal and nonsense to
    // one that does not. Disagreement between two parsers IS the bypass.
    expect(classifyIpv4('0177.0.0.1')).toBe('unparseable');
    expect(classifyIpv4('010.0.0.1')).toBe('unparseable');
    expect(classifyIpv4('1.2.3')).toBe('unparseable');
    expect(classifyIpv4('1.2.3.4.5')).toBe('unparseable');
    expect(classifyIpv4('256.1.1.1')).toBe('unparseable');
    expect(classifyIpv4('1.2.3.-4')).toBe('unparseable');
    expect(classifyIpv4('0x7f.0.0.1')).toBe('unparseable');
  });
});

describe('classifyIpv6', () => {
  it('unwraps every encoding of the metadata address', () => {
    // Each of these is 169.254.169.254 wearing a different costume, and each
    // one looks like ordinary global unicast if only the first group is read.
    expect(classifyIpv6('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyIpv6('2002:a9fe:a9fe::')).toBe('link-local');
    expect(classifyIpv6('64:ff9b::a9fe:a9fe')).toBe('link-local');
    // EC2's IPv6 metadata endpoint lives in the unique-local range.
    expect(classifyIpv6('fd00:ec2::254')).toBe('private');
  });

  it('classifies the rest of the non-public space', () => {
    expect(classifyIpv6('::1')).toBe('loopback');
    expect(classifyIpv6('::')).toBe('unspecified');
    expect(classifyIpv6('fe80::1')).toBe('link-local');
    expect(classifyIpv6('fc00::1')).toBe('private');
    expect(classifyIpv6('fec0::1')).toBe('private');
    expect(classifyIpv6('ff02::1')).toBe('multicast');
    expect(classifyIpv6('2001:db8::1')).toBe('reserved');
    expect(classifyIpv6('100::1')).toBe('reserved');
    expect(classifyIpv6('::ffff:127.0.0.1')).toBe('loopback');
  });

  it('leaves a real public address alone', () => {
    expect(classifyIpv6('2606:4700:4700::1111')).toBe('public');
    expect(classifyIpv6('2a00:1450:4009:81f::200e')).toBe('public');
  });

  it('refuses a zone index and anything malformed', () => {
    // A zone index only ever appears on a link-local address, and an address
    // that has to name an interface is not on the public internet.
    expect(classifyIpv6('fe80::1%eth0')).toBe('unparseable');
    expect(classifyIpv6('1:2:3')).toBe('unparseable');
    expect(classifyIpv6('1::2::3')).toBe('unparseable');
    expect(classifyIpv6('gggg::1')).toBe('unparseable');
    expect(classifyIpv6('1:2:3:4:5:6:7:8:9')).toBe('unparseable');
  });

  it('expands the forms the classifier depends on', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('2001:db8::8a2e:370:7334')).toEqual([
      0x2001, 0x0db8, 0, 0, 0, 0x8a2e, 0x0370, 0x7334,
    ]);
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  });

  it('routes a literal to the right classifier', () => {
    expect(classifyAddress('169.254.169.254')).toBe('link-local');
    expect(classifyAddress('::1')).toBe('loopback');
    expect(classifyAddress('example.com')).toBe('unparseable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The static destination check
// ─────────────────────────────────────────────────────────────────────────────

describe('checkActionDestination', () => {
  const refuse = (url: string): string => {
    const result = checkActionDestination(url);
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('refuses the two attacks by name', () => {
    // The brief's own examples. Both must die on the static check, before any
    // resolver is asked and long before a socket is opened.
    refuse('http://169.254.169.254/');
    refuse('https://169.254.169.254/latest/meta-data/');
    refuse('http://localhost:5432');
    refuse('https://localhost:5432');
  });

  it('refuses every IP literal, public ones included', () => {
    // An action names a HOST, so the resolver's answer is what we inspect.
    // A second "trusted literal" path would be a second thing to get right.
    refuse('https://8.8.8.8/hook');
    refuse('https://[::1]/hook');
    refuse('https://[2606:4700:4700::1111]/hook');
  });

  it('refuses internal names, including the trailing-dot spelling', () => {
    refuse('https://localhost/hook');
    refuse('https://redis./hook');
    refuse('https://kubernetes.default.svc/api');
    refuse('https://vault.internal/hook');
    refuse('https://db.cluster.local/hook');
    refuse('https://printer.local/hook');
  });

  it('refuses plaintext, embedded credentials and odd ports', () => {
    refuse('http://hooks.example.com/x');
    refuse('https://user:pass@hooks.example.com/x');
    // An action pointed at an arbitrary port is indistinguishable from a port
    // scan run out of our address space.
    refuse('https://hooks.example.com:8443/x');
    refuse('not a url');
    refuse('');
  });

  it('accepts a real destination and normalises it', () => {
    const result = checkActionDestination('  https://Hooks.Example.com./a/b?sig=1  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Rebuilt from the normalised host, so a trailing dot cannot survive
    // validation and be re-attached to the request.
    expect(result.url).toBe('https://hooks.example.com/a/b?sig=1');
    expect(result.host).toBe('hooks.example.com');
  });

  it('is strictly stricter than the send-time re-check', () => {
    /*
     * This is the test that stops a whole class of silent breakage. The POST is
     * performed by processors/notify.ts, which runs `checkChatDestination` on
     * the just-unsealed URL immediately before sending. If this module ever
     * admitted something that one refuses, every such action would pass at
     * dispatch and dead-letter at send, forever, with two different reasons in
     * two different places.
     */
    for (const url of [
      'https://hooks.example.com/services/abc',
      'https://a.b.c.example.org/path?x=1&y=2',
      'https://example.co.uk/hook',
    ]) {
      expect(checkActionDestination(url).ok).toBe(true);
      expect(checkChatDestination('WEBHOOK', url).ok).toBe(true);
    }
  });

  it('refuses a redirect target that leaves the allowed space', () => {
    /*
     * Defence in depth, and stated as such: the sender already treats a 3xx as
     * an error rather than a hop (`redirect: 'manual'` in notify.ts), so a
     * redirect never travels. This asserts the other half — that if a Location
     * ever WERE followed, the same policy applied to it still says no.
     */
    for (const location of [
      'http://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/',
      'https://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(checkActionDestination(location).ok).toBe(false);
    }
  });

  it('never puts the path in the refusal', () => {
    // The path of a webhook URL is the bearer credential.
    const reason = refuse('https://user:pass@hooks.example.com/services/T0/B0/super-secret');
    expect(reason).not.toContain('super-secret');
    expect(reason).not.toContain('/services/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIsPublic', () => {
  it('accepts a name that resolves entirely into public space', async () => {
    const result = await resolveIsPublic('hooks.example.com', async () => [
      { address: '93.184.216.34' },
      { address: '2606:4700:4700::1111' },
    ]);
    expect(result).toEqual({ ok: true, addresses: ['93.184.216.34', '2606:4700:4700::1111'] });
  });

  it('refuses a name that resolves into private space', async () => {
    const result = await resolveIsPublic('evil.example.com', async () => [
      { address: '169.254.169.254' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('169.254.169.254');
    expect(result.reason).toContain('link-local');
  });

  it('refuses when only ONE of several answers is internal', async () => {
    /*
     * The reason this checks every address instead of the first. A record set
     * that mixes a routable address with 169.254.169.254 is not a
     * misconfiguration — it is the attack, written down, and a resolver is free
     * to hand back either one when the socket is actually opened.
     */
    const result = await resolveIsPublic('mixed.example.com', async () => [
      { address: '93.184.216.34' },
      { address: '10.0.0.5' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('10.0.0.5');
  });

  it('refuses an empty answer — no addresses is not "no problem"', async () => {
    const result = await resolveIsPublic('nowhere.example.com', async () => []);
    expect(result.ok).toBe(false);
  });

  it('describes a lookup failure in the shared vocabulary', async () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const result = await resolveIsPublic('typo.example.com', async () => {
      throw notFound;
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // describeWebhookFailure's sentence, so an action's delivery log speaks the
    // same language as a chat integration's.
    expect(result.reason).toContain('DNS lookup failed');
  });

  it('gives up on a resolver that never answers', async () => {
    vi.useFakeTimers();
    const pending = resolveIsPublic('slow.example.com', () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no answer within 5s');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

const sealed = (url: string): string => `sealed:${JSON.stringify({ url })}`;
const GOOD_URL = 'https://hooks.example.com/services/T0/B0/super-secret-token';

interface ActionRow {
  id: string;
  config: Record<string, unknown>;
  configEnc: string | null;
}

const action = (over: Partial<ActionRow> = {}): ActionRow => ({
  id: 'act1',
  config: { actions: { events: ['*'] } },
  configEnc: sealed(GOOD_URL),
  ...over,
});

interface RunFixture {
  failedCount?: number;
  blocked?: string[];
  results?: Array<{ status: string; testId: string; test: { name: string; filePath: string } }>;
}

function runRow(fixture: RunFixture = {}): Record<string, unknown> {
  return {
    id: 'run1',
    projectId: 'proj1',
    environmentId: 'env1',
    status: (fixture.failedCount ?? 1) > 0 ? 'FAILED' : 'PASSED',
    trigger: 'CI',
    totalCount: 41,
    passedCount: 41 - (fixture.failedCount ?? 1),
    failedCount: fixture.failedCount ?? 1,
    flakyCount: 0,
    skippedCount: 0,
    gateResult: {
      passed: (fixture.blocked ?? []).length === 0,
      evaluations: (fixture.blocked ?? []).map((detail) => ({ action: 'BLOCK', detail })),
    },
    commitSha: 'abc1234',
    branch: 'main',
    prNumber: 7,
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    finishedAt: new Date('2026-01-01T00:05:00.000Z'),
    project: { name: 'Storefront' },
    environment: { name: 'staging' },
    results: fixture.results ?? [
      { status: 'FAILED', testId: 't1', test: { name: 'checkout', filePath: 'a.spec.ts' } },
    ],
  };
}

interface DbHandle {
  rows: Map<string, Record<string, unknown>>;
  runWhere: unknown[];
  integrationWhere: unknown[];
}

/**
 * The database, as this processor uses it. `run.findFirst` honours the orgId in
 * the where clause rather than ignoring it, so an org-isolation test actually
 * exercises the filter instead of trusting that one was written.
 */
function setupDb(opts: {
  run?: Record<string, unknown> | null;
  monitor?: Record<string, unknown> | null;
  actions?: ActionRow[];
  orgId?: string;
  failUpsertFor?: string;
  failIntegrationRead?: boolean;
  resultCount?: number;
}): DbHandle {
  const handle: DbHandle = { rows: new Map(), runWhere: [], integrationWhere: [] };
  const org = opts.orgId ?? 'org1';

  h.prisma = {
    run: {
      findFirst: async (args: { where: { id: string; orgId: string } }) => {
        handle.runWhere.push(args.where);
        if (args.where.orgId !== org) return null;
        return opts.run === undefined ? runRow() : opts.run;
      },
    },
    monitor: {
      findFirst: async (args: { where: { id: string; orgId: string } }) =>
        args.where.orgId === org ? (opts.monitor ?? null) : null,
    },
    testResult: { count: async () => opts.resultCount ?? 0 },
    integration: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        handle.integrationWhere.push(args.where);
        if (opts.failIntegrationRead) throw new Error('the database is down');
        if (args.where.orgId !== org) return [];
        return opts.actions ?? [action()];
      },
    },
    webhookDelivery: {
      upsert: async (args: { where: { id: string }; create: Record<string, unknown> }) => {
        if (opts.failUpsertFor && String(args.create.integrationId) === opts.failUpsertFor) {
          throw new Error('row write failed');
        }
        if (!handle.rows.has(args.where.id)) handle.rows.set(args.where.id, args.create);
        return handle.rows.get(args.where.id);
      },
    },
  };

  return handle;
}

const publicLookup = async (): Promise<Array<{ address: string }>> => [
  { address: '93.184.216.34' },
];

describe('processActionEvent — org isolation', () => {
  it('scopes the subject read and the action read to the job orgId', async () => {
    const db = setupDb({});
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.runWhere).toEqual([{ id: 'run1', orgId: 'org1' }]);
    // The clause itself, not the result: a findMany that forgot orgId still
    // returns rows in a unit test and only leaks in production.
    expect(db.integrationWhere[0]).toMatchObject({
      orgId: 'org1',
      enabled: true,
      kind: 'WEBHOOK',
    });
  });

  it('dispatches nothing for a run in another org', async () => {
    const db = setupDb({ orgId: 'org1' });
    await processActionEvent({ orgId: 'org2', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.rows.size).toBe(0);
    expect(h.delivered).toEqual([]);
    // It stopped at the subject read; it never even asked for org2's actions.
    expect(db.integrationWhere).toEqual([]);
  });
});

describe('processActionEvent — subscriptions', () => {
  it('queues one delivery for a subscribed action', async () => {
    const db = setupDb({ actions: [action({ config: { actions: { events: ['run.failed'] } } })] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.rows.size).toBe(1);
    const row = [...db.rows.values()][0]!;
    expect(row).toMatchObject({ status: 'PENDING', attempts: 0, event: 'run.failed' });
    expect(h.delivered).toEqual([{ orgId: 'org1', deliveryId: row.id }]);
  });

  it('writes no row at all for an action that did not subscribe', async () => {
    // "You did not ask for this" is a preference honoured, not a delivery that
    // failed, and it must not clutter the log a customer reads to find out what
    // went wrong.
    const db = setupDb({
      actions: [action({ config: { actions: { events: ['monitor.down'] } } })],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.rows.size).toBe(0);
    expect(h.delivered).toEqual([]);
  });

  it('sends a broadly-subscribed action ONE event, the narrowest', async () => {
    // Three tickets for one red run is how an automation gets turned off.
    const db = setupDb({
      run: runRow({ failedCount: 3, blocked: ['flake rate over budget'] }),
      actions: [
        action({ config: { actions: { events: ['run.finished', 'run.failed', 'gate.blocked'] } } }),
      ],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0]).toMatchObject({ event: 'gate.blocked' });
  });

  it('reports a green run that the gate blocked as gate.blocked', async () => {
    const db = setupDb({
      run: runRow({ failedCount: 0, blocked: ['p95 over budget'], results: [] }),
      actions: [action({ config: { actions: { events: ['gate.blocked'] } } })],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect([...db.rows.values()][0]).toMatchObject({ event: 'gate.blocked' });
  });

  it('logs a subscription naming an event that does not exist', async () => {
    setupDb({ actions: [action({ config: { actions: { events: ['run.suceeded'] } } })] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(
      h.log.some((line) => line.msg.includes('event names that do not exist')),
    ).toBe(true);
  });
});

describe('processActionEvent — the payload on the wire', () => {
  it('carries a decodable envelope with the run in it', async () => {
    const db = setupDb({
      run: runRow({ failedCount: 2, blocked: ['flake rate over budget'] }),
      actions: [action({ config: { actions: { events: ['*'] } } })],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    const row = [...db.rows.values()][0]!;
    const payload = row.payload as { text: string; actionEventId: string };
    const event = decodeActionEventBody(payload.text);

    expect(event).not.toBeNull();
    if (!event) return;
    expect(event.type).toBe('gate.blocked');
    expect(event.id).toBe('gate.blocked:run1');
    expect(event.specVersion).toBe(1);
    expect(event.dataVersion).toBe(1);
    expect(event.orgId).toBe('org1');
    expect(event.occurredAt).toBe('2026-01-01T00:05:00.000Z');
    expect(event.data).toMatchObject({
      runId: 'run1',
      projectName: 'Storefront',
      environmentName: 'staging',
      counts: { total: 41, passed: 39, failed: 2 },
      gate: { passed: false, blocked: ['flake rate over budget'] },
      failures: [{ testId: 't1', name: 'checkout', filePath: 'a.spec.ts', status: 'FAILED' }],
      failuresTruncated: 0,
    });
    // The idempotency key is on the row too, so a customer can quote it.
    expect(payload.actionEventId).toBe('gate.blocked:run1');
  });

  it('bounds the failure list and says how many were left out', async () => {
    const many = Array.from({ length: 21 }, (_unused, index) => ({
      status: 'FAILED',
      testId: `t${index}`,
      test: { name: `test ${index}`, filePath: 'a.spec.ts' },
    }));
    const db = setupDb({
      run: runRow({ failedCount: 30, results: many }),
      resultCount: 30,
      actions: [action()],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    const payload = ([...db.rows.values()][0]!.payload as { text: string }).text;
    const event = decodeActionEventBody(payload);
    expect(event).not.toBeNull();
    if (!event) return;
    const data = event.data as { failures: unknown[]; failuresTruncated: number };
    expect(data.failures).toHaveLength(20);
    expect(data.failuresTruncated).toBe(10);
  });

  it('uses the streak from the job, not the row that has since reset', async () => {
    const db = setupDb({
      monitor: {
        id: 'mon1',
        projectId: 'proj1',
        environmentId: 'env1',
        environment: { name: 'production' },
      },
      actions: [action({ config: { actions: { events: ['monitor.down'] } } })],
    });
    await processActionEvent(
      {
        orgId: 'org1',
        kind: 'monitor',
        monitorId: 'mon1',
        runId: 'run9',
        name: 'Checkout heartbeat',
        streak: 3,
        at: '2026-02-02T00:00:00.000Z',
      },
      { lookup: publicLookup },
    );

    const event = decodeActionEventBody(([...db.rows.values()][0]!.payload as { text: string }).text);
    expect(event).not.toBeNull();
    if (!event) return;
    expect(event.id).toBe('monitor.down:mon1:3');
    expect(event.data).toMatchObject({ name: 'Checkout heartbeat', streak: 3, runId: 'run9' });
  });
});

describe('processActionEvent — refusing a destination', () => {
  const refusedRow = async (url: string, lookup = publicLookup): Promise<Record<string, unknown>> => {
    const db = setupDb({ actions: [action({ configEnc: sealed(url) })] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, { lookup });
    expect(h.delivered).toEqual([]);
    expect(db.rows.size).toBe(1);
    return [...db.rows.values()][0]!;
  };

  it('dead-letters the metadata service with zero attempts', async () => {
    const row = await refusedRow('https://169.254.169.254/latest/meta-data/');
    // FAILED, not PENDING: retrying cannot fix a destination that is refused by
    // policy, and a PENDING row that will never move is worse than a clear no.
    expect(row).toMatchObject({ status: 'FAILED', attempts: 0 });
    expect(String(row.lastError)).toContain('IP address');
  });

  it('dead-letters a hostname that RESOLVES into the metadata service', async () => {
    // The case the static check cannot see, and the reason there is a resolver
    // step at all.
    const row = await refusedRow('https://hooks.example.com/x', async () => [
      { address: '169.254.169.254' },
    ]);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 0 });
    expect(String(row.lastError)).toContain('link-local');
  });

  it('dead-letters a database port on localhost', async () => {
    const row = await refusedRow('http://localhost:5432');
    expect(row).toMatchObject({ status: 'FAILED', attempts: 0 });
  });

  it('never records or logs the URL it refused', async () => {
    /*
     * The webhook URL IS the credential — it is bearer-authenticated by being
     * unguessable — so a refusal that echoed it would move the secret into a
     * delivery log the whole org can read, and into whatever ships our logs.
     */
    const row = await refusedRow('https://hooks.example.com/x', async () => [
      { address: '10.0.0.9' },
    ]);
    expect(String(row.lastError)).not.toContain('/x');
    expect(JSON.stringify(h.log)).not.toContain('super-secret-token');
    expect(JSON.stringify(h.log)).not.toContain('/x');
  });

  it('dead-letters an action whose credentials will not unseal', async () => {
    const db = setupDb({ actions: [action({ configEnc: 'garbage' })] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });
    expect([...db.rows.values()][0]).toMatchObject({ status: 'FAILED', attempts: 0 });
    expect(h.delivered).toEqual([]);
  });

  it('dead-letters an action with no stored destination', async () => {
    const db = setupDb({ actions: [action({ configEnc: null })] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });
    expect([...db.rows.values()][0]).toMatchObject({ status: 'FAILED', attempts: 0 });
  });
});

describe('processActionEvent — isolation and bounds', () => {
  it('keeps one failing action from costing the others their delivery', async () => {
    /*
     * The isolation guarantee. `act1`'s row write throws; `act2` and `act3`
     * must still be queued, and the processor must return normally so the run
     * that triggered this is untouched.
     */
    const db = setupDb({
      actions: [action({ id: 'act1' }), action({ id: 'act2' }), action({ id: 'act3' })],
      failUpsertFor: 'act1',
    });

    await expect(
      processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, { lookup: publicLookup }),
    ).resolves.toBeUndefined();

    expect(h.delivered).toHaveLength(2);
    expect(db.rows.size).toBe(2);
    expect(h.log.some((line) => line.msg.includes('the others are unaffected'))).toBe(true);
  });

  it('keeps one refused destination from costing the others theirs', async () => {
    const db = setupDb({
      actions: [
        action({ id: 'act1', configEnc: sealed('http://169.254.169.254/') }),
        action({ id: 'act2' }),
      ],
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(h.delivered).toHaveLength(1);
    const statuses = [...db.rows.values()].map((row) => row.status);
    expect(statuses.sort()).toEqual(['FAILED', 'PENDING']);
  });

  it('caps the fan-out and says so out loud', async () => {
    const many = Array.from({ length: MAX_ACTIONS_PER_EVENT + 1 }, (_unused, index) =>
      action({ id: `act${index}` }),
    );
    setupDb({ actions: many });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(h.delivered).toHaveLength(MAX_ACTIONS_PER_EVENT);
    // Logged, not silently truncated: a customer whose 21st action never fires
    // deserves to have that fact exist somewhere.
    expect(h.log.some((line) => line.msg.includes('more actions are registered'))).toBe(true);
  });

  it('re-throws when the actions could not be read at all', async () => {
    // Nothing was attempted, so a retry is free and correct — and the queue is
    // the only thing that can schedule one.
    setupDb({ failIntegrationRead: true });
    await expect(
      processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, { lookup: publicLookup }),
    ).rejects.toThrow('the database is down');
  });

  it('ends quietly when the subject is gone', async () => {
    // Retention swept the run, or somebody deleted it. Neither gets better on
    // the second attempt.
    const db = setupDb({ run: null });
    await expect(
      processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, { lookup: publicLookup }),
    ).resolves.toBeUndefined();
    expect(db.rows.size).toBe(0);
    expect(h.delivered).toEqual([]);
  });

  it('is idempotent across a redelivery of the same occurrence', async () => {
    /*
     * At-least-once means this WILL happen. The delivery row id and the
     * delivery job id both derive from the event id, so the second pass
     * re-claims the same row instead of paging a second time.
     */
    const db = setupDb({ actions: [action()] });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });
    await processActionEvent({ orgId: 'org1', kind: 'run', runId: 'run1' }, {
      lookup: publicLookup,
    });

    expect(db.rows.size).toBe(1);
    const ids = h.delivered.map((job) => (job as { deliveryId: string }).deliveryId);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('the notify bridge', () => {
  it('maps a finished run and a monitor page onto occurrences', () => {
    expect(
      actionJobsFromNotify({ orgId: 'org1', event: 'run.finished', payload: { runId: 'run1' } }),
    ).toMatchObject([{ orgId: 'org1', kind: 'run', runId: 'run1' }]);

    expect(
      actionJobsFromNotify({
        orgId: 'org1',
        event: 'monitor.down',
        payload: { monitorId: 'mon1', runId: 'run1', name: 'Checkout', streak: 2 },
      }),
    ).toMatchObject([{ kind: 'monitor', monitorId: 'mon1', name: 'Checkout', streak: 2 }]);
  });

  it('maps nothing it does not recognise, and nothing without a subject', () => {
    expect(actionJobsFromNotify({ orgId: 'org1', event: 'digest', payload: {} })).toEqual([]);
    expect(actionJobsFromNotify({ orgId: 'org1', event: 'run.finished', payload: {} })).toEqual([]);
    expect(actionJobsFromNotify({ orgId: 'org1', event: 'monitor.down', payload: {} })).toEqual([]);
  });

  it('enqueues with a deterministic job id so a notify retry cannot double-fire', async () => {
    await dispatchActionsForNotify({
      orgId: 'org1',
      event: 'run.finished',
      payload: { runId: 'run1' },
    });
    await dispatchActionsForNotify({
      orgId: 'org1',
      event: 'run.finished',
      payload: { runId: 'run1' },
    });

    expect(h.queued).toHaveLength(2);
    expect(h.queued[0]?.opts.jobId).toBe('action-run-run1');
    // Same id both times — BullMQ collapses the second onto the first.
    expect(h.queued[1]?.opts.jobId).toBe('action-run-run1');
    expect(h.queued[0]?.queue).toBe('qaai.actions');
  });

  it('never throws, so a broken action cannot cost a page its delivery', async () => {
    const boom = { add: async () => { throw new Error('redis is down'); }, close: async () => {} };
    const bullmq = await import('bullmq');
    const spy = vi.spyOn(bullmq.Queue.prototype, 'add').mockImplementation(boom.add);
    await expect(
      dispatchActionsForNotify({
        orgId: 'org1',
        event: 'run.finished',
        payload: { runId: 'runX' },
      }),
    ).resolves.toBeUndefined();
    expect(h.log.some((line) => line.msg.includes('could not enqueue an event action'))).toBe(true);
    spy.mockRestore();
  });
});
