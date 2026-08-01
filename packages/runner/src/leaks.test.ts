/**
 * The three properties this feature lives or dies on:
 *
 *  1. It is OFF unless a spec asked for it. A leak check that counts every row
 *     in a customer's database because they upgraded is an incident.
 *  2. A leak is a FINDING, never a failure. Nothing here may change a test's
 *     status, and the severity has to be honest enough that a gate rule keying
 *     on it means something.
 *  3. It FAILS OPEN. Every way the detector can fail to look — no driver, no
 *     secret, a production DSN, a directory it will not walk, a process table it
 *     cannot read — must produce a visible "did not check", never a silent
 *     clean bill of health, and never an exception that costs the run its result.
 *
 * The database surface is proved twice: once against fakes for the diff rules,
 * and once against the real Postgres on localhost with a deliberate leak — a
 * count that is only correct in a unit test is a count nobody should trust.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@qaai/shared';
import type { ExecutableTest, Finding, RunContext } from '@qaai/shared';
import { apiPlugin } from './plugins/api.js';
import {
  beginLeakWatch,
  cookieDomainAllowed,
  descendantsOf,
  diffCookies,
  diffFiles,
  diffProcesses,
  diffRowCounts,
  diffServiceWorkers,
  leakGateSummary,
  openPostgresRowCounter,
  parseLeakConfig,
  parseProcessTable,
  walkFiles,
} from './leaks.js';
import type { CookieLike, LeakConfig, LeakWatchDeps, RowCounter, RowCounts } from './leaks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const counts = (entries: Record<string, number>): RowCounts => new Map(Object.entries(entries));

/** A row counter that returns a scripted sequence of snapshots. */
function fakeCounter(...snapshots: RowCounts[]): {
  open: NonNullable<LeakWatchDeps['openRowCounter']>;
  closed: () => boolean;
} {
  let closed = false;
  let call = 0;
  return {
    open: async (): Promise<RowCounter> => ({
      counts: async () => snapshots[Math.min(call++, snapshots.length - 1)] ?? new Map(),
      close: async () => {
        closed = true;
      },
    }),
    closed: () => closed,
  };
}

const config = (over: Partial<LeakConfig>): LeakConfig => ({ enabled: true, ...over });

const codes = (findings: Finding[]): string[] => findings.map((f) => f.code).sort();
const byCode = (findings: Finding[], code: string): Finding | undefined =>
  findings.find((f) => f.code === code);

const dbConfig = {
  connectionSecretName: 'LEAK_DB',
  schemas: ['public'],
  ignoreTables: [],
  maxTables: 300,
  statementTimeoutMs: 15_000,
  allowProductionDatabase: false,
};

// ─── 1. Off by default ───────────────────────────────────────────────────────

describe('leak checking is off unless the spec asked for it', () => {
  it.each([
    ['no spec at all', undefined],
    ['a spec that is not an object', 'nope'],
    ['a spec with no leakCheck block', { steps: [] }],
    ['an explicit null block', { leakCheck: null }],
    ['a block that does not enable it', { leakCheck: { database: { connectionSecretName: 'X' } } }],
    ['a block that disables it', { leakCheck: { enabled: false } }],
  ])('%s means no leak checking', (_label, spec) => {
    expect(parseLeakConfig(spec)).toBeNull();
  });

  it('turns on only for an explicit enabled: true', () => {
    const parsed = parseLeakConfig({ leakCheck: { enabled: true } });
    expect(parsed?.enabled).toBe(true);
    expect(parsed?.configError).toBeUndefined();
  });

  it('applies documented defaults rather than making the caller repeat them', () => {
    const parsed = parseLeakConfig({
      leakCheck: { enabled: true, database: { connectionSecretName: 'LEAK_DB' } },
    });
    expect(parsed?.database?.schemas).toEqual(['public']);
    expect(parsed?.database?.allowProductionDatabase).toBe(false);
  });
});

describe('a malformed leakCheck block is reported, not obeyed and not ignored', () => {
  it('does not quietly read as "off"', () => {
    // The failure mode this exists to prevent: a typo in the block means the
    // team believes they have leak checking and they have nothing.
    const parsed = parseLeakConfig({
      leakCheck: { enabled: true, database: { schemas: 'public' } },
    });
    expect(parsed?.configError).toMatch(/invalid/i);
  });

  it('produces an inconclusive finding and checks nothing else', async () => {
    const parsed = parseLeakConfig({ leakCheck: { enabled: true, database: {} } })!;
    const watch = await beginLeakWatch(parsed, { secrets: {} });
    const findings = await watch.finish();

    expect(codes(findings)).toEqual(['leak.config.inconclusive']);
    expect(findings[0]!.severity).toBe('MINOR');
  });
});

// ─── 2. The diff rules ───────────────────────────────────────────────────────

describe('row-count diffing', () => {
  it('separates growth, loss, and structural change', () => {
    const diff = diffRowCounts(
      counts({ 'public.orders': 10, 'public.users': 5, 'public.old': 1 }),
      counts({ 'public.orders': 13, 'public.users': 4, 'public.new': 2 }),
    );

    expect(diff.grew).toEqual([{ table: 'public.orders', before: 10, after: 13 }]);
    expect(diff.shrank).toEqual([{ table: 'public.users', before: 5, after: 4 }]);
    expect(diff.appeared).toEqual(['public.new']);
    expect(diff.disappeared).toEqual(['public.old']);
  });

  it('says nothing when the test put everything back', () => {
    const before = counts({ 'public.orders': 10 });
    const diff = diffRowCounts(before, counts({ 'public.orders': 10 }));
    expect(diff).toEqual({ grew: [], shrank: [], appeared: [], disappeared: [] });
  });

  it('honours an ignore list by qualified or bare name', () => {
    const before = counts({ 'public.jobs': 0, 'public.audit_log': 0 });
    const after = counts({ 'public.jobs': 7, 'public.audit_log': 3 });

    expect(diffRowCounts(before, after, ['public.jobs', 'audit_log']).grew).toEqual([]);
    // …and does not swallow a table that merely looks similar.
    expect(diffRowCounts(before, after, ['jobs_archive']).grew).toHaveLength(2);
  });
});

describe('cookie domain rules follow Set-Cookie, not string equality', () => {
  it.each([
    ['exact host', 'app.example.com', ['app.example.com'], true],
    ['leading dot on the cookie', '.example.com', ['example.com'], true],
    ['subdomain of an allowed domain', 'api.example.com', ['example.com'], true],
    ['leading dot in the allow-list', 'api.example.com', ['.example.com'], true],
    ['a different registrable domain', 'evil.net', ['example.com'], false],
    // The suffix trap: `notexample.com` must not pass because it ends with the
    // allowed string.
    ['a domain that merely ends with one', 'notexample.com', ['example.com'], false],
  ])('%s', (_label, domain, allowed, expected) => {
    expect(cookieDomainAllowed(domain, allowed)).toBe(expected);
  });

  it('reports only cookies that are both new and off-domain', () => {
    const before: CookieLike[] = [{ name: 'pre', domain: 'tracker.io' }];
    const after: CookieLike[] = [
      { name: 'pre', domain: 'tracker.io' },
      { name: 'session', domain: 'app.example.com' },
      { name: 'ad', domain: 'tracker.io' },
    ];

    // `pre` was there before the test — not this test's residue.
    expect(diffCookies(before, after, ['example.com'])).toEqual([
      { name: 'ad', domain: 'tracker.io' },
    ]);
  });
});

describe('service worker and process diffing', () => {
  it('only reports workers registered during the window', () => {
    expect(
      diffServiceWorkers(['https://a/sw.js'], ['https://a/sw.js', 'https://a/sw2.js']),
    ).toEqual(['https://a/sw2.js']);
  });

  it('only reports processes that appeared during the window', () => {
    // A worker legitimately keeps long-lived children. Reporting those on every
    // test is a false positive per test, which is how a feature gets muted.
    const before = [{ pid: 1, ppid: 0, command: 'browser' }];
    const after = [
      { pid: 1, ppid: 0, command: 'browser' },
      { pid: 2, ppid: 1, command: 'stray-server' },
    ];

    expect(diffProcesses(before, after)).toEqual([{ pid: 2, ppid: 1, command: 'stray-server' }]);
    expect(diffProcesses(before, after, ['stray-server'])).toEqual([]);
  });

  it('finds grandchildren, not just direct children', () => {
    const rows = [
      { pid: 10, ppid: 1, command: 'runner' },
      { pid: 11, ppid: 10, command: 'shell' },
      { pid: 12, ppid: 11, command: 'server' },
      { pid: 20, ppid: 1, command: 'unrelated' },
    ];
    expect(descendantsOf(rows, 10).map((p) => p.pid)).toEqual([11, 12]);
  });

  it('parses a ps table whose command contains spaces', () => {
    expect(parseProcessTable('  123   1 Google Chrome Helper\n  bad line\n 4 2 node\n')).toEqual([
      { pid: 123, ppid: 1, command: 'Google Chrome Helper' },
      { pid: 4, ppid: 2, command: 'node' },
    ]);
  });
});

// ─── 3. Findings, and the honesty of their severity ──────────────────────────

describe('database residue becomes a finding with an honest severity', () => {
  it('reports rows the test created and did not clean up', async () => {
    const counter = fakeCounter(counts({ 'public.orders': 4 }), counts({ 'public.orders': 7 }));
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://u:p@localhost:5432/testdb' },
      openRowCounter: counter.open,
    });

    const findings = await watch.finish();
    const finding = byCode(findings, 'leak.database.rows')!;

    expect(findings).toHaveLength(1);
    expect(finding.kind).toBe('PERFORMANCE');
    expect(finding.severity).toBe('MODERATE');
    expect(finding.location).toBe('public.orders');
    expect(finding.message).toContain('3 row(s)');
    // The connection is ours; leaking it while looking for leaks would be a poor
    // advertisement.
    expect(counter.closed()).toBe(true);
  });

  it('escalates a leak big enough to be a loop', async () => {
    const counter = fakeCounter(counts({ 'public.events': 0 }), counts({ 'public.events': 250 }));
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost/testdb' },
      openRowCounter: counter.open,
    });

    expect(byCode(await watch.finish(), 'leak.database.rows')!.severity).toBe('SERIOUS');
  });

  it('treats destroying rows it did not create as worse than adding some', async () => {
    const counter = fakeCounter(counts({ 'public.users': 9 }), counts({ 'public.users': 2 }));
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost/testdb' },
      openRowCounter: counter.open,
    });

    const finding = byCode(await watch.finish(), 'leak.database.rows-deleted')!;
    expect(finding.severity).toBe('SERIOUS');
    expect(finding.message).toContain('7 row(s)');
  });

  it('reports a table that outlived the test', async () => {
    const counter = fakeCounter(counts({}), counts({ 'public.tmp_import': 0 }));
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost/testdb' },
      openRowCounter: counter.open,
    });

    expect(byCode(await watch.finish(), 'leak.database.tables')!.severity).toBe('SERIOUS');
  });

  it('says nothing at all when the test cleaned up after itself', async () => {
    const counter = fakeCounter(counts({ 'public.orders': 4 }), counts({ 'public.orders': 4 }));
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost/testdb' },
      openRowCounter: counter.open,
    });

    expect(await watch.finish()).toEqual([]);
  });
});

// ─── 4. Fail open ────────────────────────────────────────────────────────────

describe('a check that cannot run says so instead of reporting clean', () => {
  const expectInconclusive = (findings: Finding[], surface: string, match: RegExp): void => {
    const finding = byCode(findings, `leak.${surface}.inconclusive`);
    expect(finding, `expected a leak.${surface}.inconclusive finding`).toBeDefined();
    expect(finding!.severity).toBe('MINOR');
    expect(finding!.message).toMatch(match);
  };

  it('when the vault secret holding the DSN is missing', async () => {
    const watch = await beginLeakWatch(config({ database: dbConfig }), { secrets: {} });
    expectInconclusive(await watch.finish(), 'database', /LEAK_DB is not set/);
  });

  it('when the driver or the database is unreachable', async () => {
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost:5432/testdb' },
      openRowCounter: async () => {
        throw new Error('connection refused');
      },
    });
    expectInconclusive(await watch.finish(), 'database', /connection refused/);
  });

  it('when the count succeeds before the test and fails after it', async () => {
    let call = 0;
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://localhost:5432/testdb' },
      openRowCounter: async () => ({
        counts: async () => {
          if (call++ === 0) return counts({ 'public.orders': 1 });
          throw new Error('statement timeout');
        },
        close: async () => undefined,
      }),
    });
    expectInconclusive(await watch.finish(), 'database', /statement timeout/);
  });

  it('when the DSN looks like production and nobody opted in', async () => {
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: 'postgres://user@db.internal:5432/app_production' },
      openRowCounter: async () => {
        throw new Error('should never be opened');
      },
    });
    expectInconclusive(await watch.finish(), 'database', /looks like production/);
  });

  it('when only part of the schema fits under the table cap', async () => {
    const counter = fakeCounter(counts({ a: 1, b: 2 }), counts({ a: 1, b: 2 }));
    const watch = await beginLeakWatch(config({ database: { ...dbConfig, maxTables: 2 } }), {
      secrets: { LEAK_DB: 'postgres://localhost/testdb' },
      openRowCounter: counter.open,
    });
    expectInconclusive(await watch.finish(), 'database', /only the first 2 tables/);
  });

  it('when the process table cannot be read', async () => {
    const watch = await beginLeakWatch(config({ processes: { ignoreCommands: [] } }), {
      secrets: {},
      listProcesses: async () => {
        throw new Error('spawn ps ENOENT');
      },
    });
    expectInconclusive(await watch.finish(), 'processes', /ENOENT/);
  });

  it('when a browser surface is configured on a test that has no browser', async () => {
    const watch = await beginLeakWatch(
      config({ storage: { allowedCookieDomains: [], expectDisposed: false } }),
      { secrets: {} },
    );
    expectInconclusive(await watch.finish(), 'storage', /no browser context/);
  });

  it('and one broken surface never suppresses another surface that found a real leak', async () => {
    // The compound failure worth guarding: a missing driver must not turn a
    // genuine process leak into silence.
    let call = 0;
    const watch = await beginLeakWatch(
      config({ database: dbConfig, processes: { ignoreCommands: [] } }),
      {
        secrets: { LEAK_DB: 'postgres://localhost/testdb' },
        openRowCounter: async () => {
          throw new Error('no driver');
        },
        rootPid: 1,
        listProcesses: async () =>
          call++ === 0 ? [] : [{ pid: 4242, ppid: 1, command: 'orphaned-server' }],
      },
    );

    const findings = await watch.finish();
    expect(codes(findings)).toEqual(['leak.database.inconclusive', 'leak.process.unreaped']);
  });

  it('never throws out of finish(), whatever the surfaces do', async () => {
    const watch = await beginLeakWatch(
      config({
        database: dbConfig,
        files: {
          directories: ['/definitely/not/here'],
          temporaryDirectories: [],
          ignore: [],
          maxEntries: 10,
        },
        processes: { ignoreCommands: [] },
      }),
      {
        secrets: { LEAK_DB: 'postgres://localhost/testdb' },
        openRowCounter: async () => ({
          counts: async () => counts({ 'public.t': 0 }),
          close: async () => {
            throw new Error('close blew up');
          },
        }),
        listProcesses: async () => {
          throw new Error('no ps');
        },
      },
    );

    await expect(watch.finish()).resolves.toBeInstanceOf(Array);
  });
});

describe('secrets never ride out inside a finding', () => {
  it('masks a DSN password that surfaces in a driver error', async () => {
    const dsn = 'postgres://qaai:sup3rsecretpassword@localhost:5432/testdb';
    const watch = await beginLeakWatch(config({ database: dbConfig }), {
      secrets: { LEAK_DB: dsn },
      openRowCounter: async () => {
        throw new Error(`password authentication failed for ${dsn}`);
      },
    });

    const message = (await watch.finish())[0]!.message;
    expect(message).not.toContain('sup3rsecretpassword');
    expect(message).toContain(SECRET_MASK);
  });
});

// ─── 5. Files ────────────────────────────────────────────────────────────────

describe('files left in a watched directory', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qaai-leaks-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const filesConfig = (over: Partial<NonNullable<LeakConfig['files']>> = {}) => ({
    directories: [dir],
    temporaryDirectories: [],
    ignore: ['.git', 'node_modules'],
    maxEntries: 20_000,
    ...over,
  });

  it('reports a file the test created, however deep', async () => {
    const watch = await beginLeakWatch(config({ files: filesConfig() }), { secrets: {} });

    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'orders.json'), '{}');

    const finding = byCode(await watch.finish(), 'leak.files.workspace')!;
    expect(finding.severity).toBe('MODERATE');
    expect(finding.message).toContain('nested/orders.json');
  });

  it('is quiet when the test cleaned up, and when it only read', async () => {
    await writeFile(join(dir, 'fixture.json'), '{}');
    const watch = await beginLeakWatch(config({ files: filesConfig() }), { secrets: {} });

    await writeFile(join(dir, 'scratch.txt'), 'x');
    await rm(join(dir, 'scratch.txt'));

    expect(await watch.finish()).toEqual([]);
  });

  it('grades residue in a declared temp directory as minor', async () => {
    const watch = await beginLeakWatch(
      config({ files: filesConfig({ temporaryDirectories: [dir] }) }),
      { secrets: {} },
    );

    await writeFile(join(dir, 'scratch.tmp'), 'x');

    const finding = byCode(await watch.finish(), 'leak.files.temp')!;
    expect(finding.severity).toBe('MINOR');
  });

  it('treats deleting a file it did not create as destructive', async () => {
    await writeFile(join(dir, 'fixture.json'), '{}');
    const watch = await beginLeakWatch(config({ files: filesConfig() }), { secrets: {} });

    await rm(join(dir, 'fixture.json'));

    expect(byCode(await watch.finish(), 'leak.files.deleted')!.severity).toBe('SERIOUS');
  });

  it('ignores the directories nobody means to watch', async () => {
    const watch = await beginLeakWatch(config({ files: filesConfig() }), { secrets: {} });

    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), '');

    expect(await watch.finish()).toEqual([]);
  });

  it('refuses to walk a home directory, and says it refused', async () => {
    const watch = await beginLeakWatch(
      config({ files: filesConfig({ directories: [homedir()] }) }),
      { secrets: {} },
    );

    const finding = byCode(await watch.finish(), 'leak.files.inconclusive')!;
    expect(finding.message).toMatch(/not a workspace/);
  });

  it('walks a directory that did not exist yet rather than erroring', async () => {
    const fresh = join(dir, 'created-by-the-test');
    const watch = await beginLeakWatch(config({ files: filesConfig({ directories: [fresh] }) }), {
      secrets: {},
    });

    await mkdir(fresh, { recursive: true });
    await writeFile(join(fresh, 'left-behind.log'), 'x');

    expect(codes(await watch.finish())).toEqual(['leak.files.workspace']);
  });

  it('stops rather than half-walking a directory it cannot finish', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `f${i}`), 'x');
    const { truncated } = await walkFiles(dir, { ignore: [], maxEntries: 2 });
    expect(truncated).toBe(true);
  });

  it('diffs a walk by presence, not by content', async () => {
    // Editing a fixture in place is not residue: the file was there before and
    // is there after. Only appearing and disappearing count.
    const before = new Map([['kept', { size: 1, mtimeMs: 1 }]]);
    const after = new Map([
      ['kept', { size: 900, mtimeMs: 2 }],
      ['new', { size: 1, mtimeMs: 2 }],
    ]);
    expect(diffFiles(before, after)).toEqual({ created: ['new'], deleted: [] });
    expect(diffFiles(after, before)).toEqual({ created: [], deleted: ['new'] });
  });
});

// ─── 6. Browser storage ──────────────────────────────────────────────────────

describe('browser state that outlived the context', () => {
  const probe = (cookies: CookieLike[][], workers: string[][] = [[], []]) => {
    let call = 0;
    let workerCall = 0;
    return {
      cookies: async () => cookies[Math.min(call++, cookies.length - 1)] ?? [],
      serviceWorkers: () =>
        (workers[Math.min(workerCall++, workers.length - 1)] ?? []).map((url) => ({ url })),
    };
  };

  const storageConfig = { allowedCookieDomains: [], expectDisposed: false };

  it('reports a cookie left on a domain that is not under test', async () => {
    const watch = await beginLeakWatch(config({ storage: storageConfig }), {
      secrets: {},
      baseUrl: 'https://app.example.com',
      storage: probe([[], [{ name: 'ad_id', domain: '.tracker.io' }]]),
    });

    const finding = byCode(await watch.finish(), 'leak.storage.cookie-domain')!;
    expect(finding.severity).toBe('SERIOUS');
    expect(finding.location).toBe('.tracker.io');
  });

  it('leaves the application’s own cookies alone, subdomains included', async () => {
    const watch = await beginLeakWatch(config({ storage: storageConfig }), {
      secrets: {},
      baseUrl: 'https://example.com/login',
      storage: probe([[], [{ name: 'session', domain: 'api.example.com' }]]),
    });

    expect(await watch.finish()).toEqual([]);
  });

  it('reports a service worker still registered at the end', async () => {
    const watch = await beginLeakWatch(config({ storage: storageConfig }), {
      secrets: {},
      baseUrl: 'https://example.com',
      storage: probe([[], []], [[], ['https://example.com/sw.js']]),
    });

    const finding = byCode(await watch.finish(), 'leak.storage.service-worker')!;
    expect(finding.severity).toBe('MODERATE');
  });

  it('reports a context that should have been disposed and answered anyway', async () => {
    const watch = await beginLeakWatch(
      config({ storage: { ...storageConfig, expectDisposed: true } }),
      { secrets: {}, baseUrl: 'https://example.com', storage: probe([[], []]) },
    );

    expect(byCode(await watch.finish(), 'leak.storage.context-open')!.severity).toBe('SERIOUS');
  });

  it('says nothing when the context was closed, which is the point', async () => {
    let call = 0;
    const watch = await beginLeakWatch(
      config({ storage: { ...storageConfig, expectDisposed: true } }),
      {
        secrets: {},
        baseUrl: 'https://example.com',
        storage: {
          cookies: async () => {
            if (call++ === 0) return [];
            throw new Error('Target page, context or browser has been closed');
          },
        },
      },
    );

    expect(await watch.finish()).toEqual([]);
  });
});

// ─── 7. Open handles ─────────────────────────────────────────────────────────

describe('a process the test spawned and did not reap', () => {
  it('reports a real child that is still alive, and not one that exited', async () => {
    const watch = await beginLeakWatch(config({ processes: { ignoreCommands: [] } }), {
      secrets: {},
      // The process table is stubbed out so this test asserts the tracking path
      // alone; a live `ps` here would race with vitest's own workers.
      listProcesses: async () => [],
    });

    // Spawned WITHOUT a shell, args as an array.
    const survivor = spawn('sleep', ['30'], { shell: false, stdio: 'ignore' });
    const reaped = spawn('sleep', ['0'], { shell: false, stdio: 'ignore' });
    await new Promise((resolve) => reaped.on('exit', resolve));

    watch.track(survivor.pid!);
    watch.track(reaped.pid!);

    try {
      const findings = await watch.finish();
      expect(findings).toHaveLength(1);
      expect(findings[0]!.code).toBe('leak.process.unreaped');
      expect(findings[0]!.severity).toBe('SERIOUS');
      expect(findings[0]!.location).toBe(`pid ${survivor.pid}`);
    } finally {
      survivor.kill('SIGKILL');
    }
  });

  it('is quiet when the test reaped everything it started', async () => {
    const watch = await beginLeakWatch(config({ processes: { ignoreCommands: [] } }), {
      secrets: {},
      listProcesses: async () => [],
    });
    expect(await watch.finish()).toEqual([]);
  });
});

// ─── 8. What a gate rule gets to act on ──────────────────────────────────────

describe('the gate summary', () => {
  const finding = (code: string, severity: Finding['severity']): Finding => ({
    kind: 'PERFORMANCE',
    severity,
    code,
    message: '',
    location: '',
    helpUrl: null,
  });

  it('reports the worst real leak, and counts what was not checked separately', () => {
    const summary = leakGateSummary([
      finding('leak.files.temp', 'MINOR'),
      finding('leak.database.rows', 'MODERATE'),
      finding('leak.process.unreaped', 'SERIOUS'),
      finding('leak.storage.inconclusive', 'MINOR'),
      // Another plugin's finding must not be counted as a leak.
      { ...finding('color-contrast', 'CRITICAL'), kind: 'ACCESSIBILITY' },
    ]);

    expect(summary).toEqual({
      leakCount: 3,
      inconclusiveCount: 1,
      worstSeverity: 'SERIOUS',
      codes: ['leak.database.rows', 'leak.files.temp', 'leak.process.unreaped'],
    });
  });

  it('distinguishes "checked and clean" from "never checked"', () => {
    expect(leakGateSummary([])).toMatchObject({
      leakCount: 0,
      inconclusiveCount: 0,
      worstSeverity: null,
    });
    expect(leakGateSummary([finding('leak.database.inconclusive', 'MINOR')])).toMatchObject({
      leakCount: 0,
      inconclusiveCount: 1,
      worstSeverity: null,
    });
  });
});

// ─── 9. The real thing: Postgres on localhost, with a deliberate leak ────────

const DSN =
  process.env.LEAK_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://qaai:qaai@localhost:5432/qaai';

/**
 * Probed at collection time rather than in beforeAll, because `describe.skipIf`
 * needs the answer before the suite is defined. A developer without Postgres
 * gets a skipped suite, never a red one — the same rule the runner applies to a
 * missing tool.
 */
const pgReachable = await (async (): Promise<boolean> => {
  try {
    const counter = await openPostgresRowCounter(DSN, { ...dbConfig, maxTables: 1 });
    await counter.counts();
    await counter.close();
    return true;
  } catch {
    return false;
  }
})();

interface RawPgClient {
  connect(): Promise<void>;
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

describe.skipIf(!pgReachable)('against the real Postgres, with a deliberate leak', () => {
  // Its own schema: the point is to prove the counter against a live server, not
  // to sweep the application's own tables on every run of the unit suite.
  const schema = `qaai_leak_probe_${process.pid}`;
  const probeConfig = { ...dbConfig, schemas: [schema] };
  const deps = { secrets: { LEAK_DB: DSN } };

  let client: RawPgClient | undefined;
  const sql = async (text: string): Promise<Array<Record<string, unknown>>> =>
    (await client!.query(text)).rows;

  beforeAll(async () => {
    const { Client } = (await import('pg')) as unknown as {
      Client: new (c: { connectionString: string }) => RawPgClient;
    };
    client = new Client({ connectionString: DSN });
    await client.connect();

    await sql(`drop schema if exists ${schema} cascade`);
    await sql(`create schema ${schema}`);
    await sql(`create table ${schema}.orders (id serial primary key, sku text)`);
    await sql(`insert into ${schema}.orders (sku) values ('pre-existing')`);
  });

  afterAll(async () => {
    // A leak-detection suite that leaked its own schema would be a poor advert.
    if (!client) return;
    await sql(`drop schema if exists ${schema} cascade`);
    await client.end();
  });

  it('counts real rows and reports the ones a test left behind', async () => {
    const watch = await beginLeakWatch(config({ database: probeConfig }), deps);

    // The deliberate leak: three committed rows nobody cleans up.
    await sql(`insert into ${schema}.orders (sku) values ('a'), ('b'), ('c')`);

    const findings = await watch.finish();
    const finding = byCode(findings, 'leak.database.rows')!;

    expect(codes(findings)).toEqual(['leak.database.rows']);
    expect(finding.location).toBe(`${schema}.orders`);
    expect(finding.message).toContain('3 row(s)');
    expect(finding.message).toContain('1 → 4');
    expect(finding.severity).toBe('MODERATE');
  });

  it('is silent when the test rolled back what it did — the DATABASE plugin’s contract', async () => {
    const watch = await beginLeakWatch(config({ database: probeConfig }), deps);

    await sql(`begin`);
    await sql(`insert into ${schema}.orders (sku) values ('rolled-back')`);
    await sql(`rollback`);

    expect(await watch.finish()).toEqual([]);
  });

  it('catches a table created during the test', async () => {
    const watch = await beginLeakWatch(config({ database: probeConfig }), deps);

    await sql(`create table ${schema}.tmp_import (id int)`);

    const finding = byCode(await watch.finish(), 'leak.database.tables')!;
    expect(finding.location).toBe(`${schema}.tmp_import`);
    expect(finding.severity).toBe('SERIOUS');
  });

  it('catches rows a test destroyed that it did not create', async () => {
    await sql(`insert into ${schema}.orders (sku) values ('victim')`);
    const watch = await beginLeakWatch(config({ database: probeConfig }), deps);

    await sql(`delete from ${schema}.orders where sku = 'victim'`);

    expect(byCode(await watch.finish(), 'leak.database.rows-deleted')).toBeDefined();
  });

  it('does not itself leak the connection it opened', async () => {
    // The detector is subject to its own rule. `application_name` is set on the
    // counter's session precisely so this is answerable from outside.
    const watch = await beginLeakWatch(config({ database: probeConfig }), deps);
    const during = await sql(
      `select count(*)::int as n from pg_stat_activity where application_name = 'qaai-leak-check'`,
    );
    await watch.finish();
    const after = await sql(
      `select count(*)::int as n from pg_stat_activity where application_name = 'qaai-leak-check'`,
    );

    expect(during[0]!.n).toBe(1);
    expect(after[0]!.n).toBe(0);
  });

  it('refuses to sweep a database that looks like production', async () => {
    // Same DSN, renamed to look live: a read-only sweep is still count(*) over
    // every table on a system serving customers.
    const productionish = DSN.replace(/\/[^/?]+(\?|$)/, '/app_production$1');
    const watch = await beginLeakWatch(config({ database: probeConfig }), {
      secrets: { LEAK_DB: productionish },
    });

    const finding = byCode(await watch.finish(), 'leak.database.inconclusive')!;
    expect(finding.message).toMatch(/looks like production/);
  });

  // ── and the whole thing, through the plugin that wires it up ──
  describe('an API test whose request leaves a row behind', () => {
    /** A one-route application that persists what it is POSTed and never cleans up. */
    const startApp = async (): Promise<{ url: string; stop: () => Promise<void> }> => {
      const server = createServer((req, res) => {
        void (async () => {
          if (req.method === 'POST' && req.url === '/orders') {
            await sql(`insert into ${schema}.orders (sku) values ('via-http')`);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404);
          res.end();
        })();
      });
      await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
      const { port } = server.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      };
    };

    const runContext = (baseUrl: string): RunContext =>
      ({
        runId: 'run_leak',
        orgId: 'org_leak',
        projectId: 'proj_leak',
        environmentId: 'env_leak',
        baseUrl,
        secrets: { LEAK_DB: DSN },
        storageState: null,
        artifacts: {
          put: async () => 'k',
          putFile: async () => 'k',
          get: async () => null,
          putPersistent: async () => 'k',
        },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          step: () => undefined,
        },
        signal: new AbortController().signal,
        determinism: {
          freezeClockAt: null,
          randomSeed: 1,
          waitForNetworkIdle: false,
          retryOnce: false,
        },
      }) satisfies RunContext;

    const test = (leakCheck: unknown): ExecutableTest => ({
      id: 'test_leak',
      name: 'creates an order',
      type: 'API',
      code: '',
      filePath: 'tests/orders.api.json',
      spec: {
        steps: [
          { name: 'create an order', method: 'POST', path: '/orders', assertions: { status: 201 } },
        ],
        leakCheck,
      },
      timeoutMs: 30_000,
      quarantined: false,
      tags: [],
    });

    it('passes, and reports the leak as a finding rather than a failure', async () => {
      const app = await startApp();
      try {
        const execution = await apiPlugin.execute(
          runContext(app.url),
          test({ enabled: true, database: { connectionSecretName: 'LEAK_DB', schemas: [schema] } }),
        );

        // The assertion the customer wrote held. That is the whole point: the
        // test is green and the residue is still on the record.
        expect(execution.status).toBe('PASSED');
        expect(execution.steps.every((s) => s.status === 'PASSED')).toBe(true);
        expect(execution.errorMessage).toBeNull();

        const finding = byCode(execution.findings, 'leak.database.rows')!;
        expect(finding.location).toBe(`${schema}.orders`);
        expect(finding.message).toContain('1 row(s)');
        expect(leakGateSummary(execution.findings)).toMatchObject({
          leakCount: 1,
          inconclusiveCount: 0,
          worstSeverity: 'MODERATE',
        });
      } finally {
        await app.stop();
      }
    });

    it('and the same test without the block does no checking at all', async () => {
      const app = await startApp();
      try {
        const execution = await apiPlugin.execute(runContext(app.url), test(undefined));
        expect(execution.status).toBe('PASSED');
        // Off by default: the row this request left behind is real, and nobody
        // asked us to look for it.
        expect(execution.findings).toEqual([]);
      } finally {
        await app.stop();
      }
    });
  });
});
