/**
 * Tests for materialising a customer's repository into a run workspace.
 *
 * Three things here are worth more than the rest of the file:
 *
 *  1. **The traversal and link refusals.** This code writes to disk AS THE
 *     WORKER, which holds VAULT_MASTER_KEY, DATABASE_URL and SESSION_SECRET. A
 *     tar entry named `../../etc/cron.d/x`, or a symlink pointing at `/`, is a
 *     write outside the workspace, and the whole point of unpacking the archive
 *     in JavaScript rather than shelling out to `tar` is that those two cases
 *     are decided here, by code with a test on it.
 *
 *  2. **Every cap, breached cheaply.** The real limits are in the hundreds of
 *     megabytes, so the limits are a default argument and these tests override
 *     them. A cap that is only exercised by a 128 MiB fixture is a cap nobody
 *     ever proves works.
 *
 *  3. **Nothing is left behind.** A half-extracted tree looks like the
 *     repository and is not, so a refusal removes the directory. A workspace
 *     leaked per run fills a shared worker's disk in a day.
 *
 * The archive fixtures are built by hand — 512-byte headers, octal fields, a
 * checksum — because the alternative is a fixture file nobody can read and a
 * dependency on the host having `tar`.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXTRACTION_LIMITS,
  ExtractionRefused,
  REPO_DEPENDENT_TEST_TYPES,
  testNeedsRepository,
  extractTarGz,
  materialiseRepoWorkspace,
  repoUnavailableMessage,
  type ArchiveDownloader,
} from './repo-materialise.js';

// ─── A tarball, by hand ──────────────────────────────────────────────────────

interface Entry {
  name: string;
  body?: string;
  /** '0' file, '5' directory, '2' symlink, '1' hardlink, 'x' pax header. */
  type?: string;
  mode?: number;
  /** Lie about the size, to breach a cap without allocating the bytes. */
  declaredSize?: number;
  linkName?: string;
}

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, 'utf8');
  block.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  block.write('00000000000\0', 136, 12, 'latin1');
  // The checksum is computed over the header with this field read as spaces.
  block.write('        ', 148, 8, 'latin1');
  block.write(entry.type ?? '0', 156, 1, 'latin1');
  if (entry.linkName) block.write(entry.linkName, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');

  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

/** A gzipped tar of these entries, with the two trailing zero blocks. */
function archive(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '', 'utf8');
    const size = entry.declaredSize ?? body.length;
    parts.push(header(entry, entry.type === '5' ? 0 : size));
    if (entry.type !== '5' && body.length > 0) {
      parts.push(body);
      const padding = body.length % 512 === 0 ? 0 : 512 - (body.length % 512);
      if (padding) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const bytes = (buffer: Buffer): AsyncIterable<Uint8Array> => ({
  // Deliberately chunked small, so the reader's own reassembly across chunk
  // boundaries is what is under test rather than one convenient buffer.
  async *[Symbol.asyncIterator]() {
    for (let at = 0; at < buffer.length; at += 100) yield buffer.subarray(at, at + 100);
  },
});

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

let dest = '';
let outside = '';

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), 'qaai-extract-test-'));
  outside = await mkdtemp(join(tmpdir(), 'qaai-outside-test-'));
});

afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('unpacking a repository archive', () => {
  it('writes the tree with the wrapper directory stripped', async () => {
    const result = await extractTarGz(
      bytes(
        archive([
          { name: 'acme-app-abc123/', type: '5' },
          { name: 'acme-app-abc123/package.json', body: '{"name":"app"}' },
          { name: 'acme-app-abc123/src/cart.ts', body: 'export const total = 1;' },
          { name: 'acme-app-abc123/scripts/test.sh', body: '#!/bin/sh\n', mode: 0o755 },
        ]),
      ),
      dest,
      { stripComponents: 1 },
    );

    expect(await walk(dest)).toEqual(['package.json', 'scripts/test.sh', 'src/cart.ts']);
    expect(result.files).toBe(3);
    expect(readFileSync(join(dest, 'src/cart.ts'), 'utf8')).toBe('export const total = 1;');
    // The command a spec runs is often `./scripts/test.sh`, so the executable
    // bit has to survive — and nothing else from the archive's mode does.
    const mode = (await stat(join(dest, 'scripts/test.sh'))).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
    expect(mode & 0o077).toBe(0);
  });

  it('reads a long path out of a pax header, which is how git archive writes one', async () => {
    const long = `acme-app-abc123/${'nested/'.repeat(20)}deep.ts`;
    const record = `${`path=${long}\n`.length + 4} path=${long}\n`;
    await extractTarGz(
      bytes(
        archive([
          { name: 'PaxHeaders/0', type: 'x', body: record },
          { name: 'acme-app-abc123/truncated.ts', body: 'x' },
        ]),
      ),
      dest,
      { stripComponents: 1 },
    );

    expect(await walk(dest)).toEqual([`${'nested/'.repeat(20)}deep.ts`]);
  });

  it('refuses an entry whose path escapes the workspace, and leaves nothing behind', async () => {
    const escape = `../../${outside.split('/').pop()}/pwned.txt`;
    await expect(
      extractTarGz(
        bytes(
          archive([
            { name: 'acme-app-abc123/ok.ts', body: 'fine' },
            { name: `acme-app-abc123/${escape}`, body: 'owned' },
          ]),
        ),
        dest,
        { stripComponents: 1 },
      ),
    ).rejects.toThrow(ExtractionRefused);

    // Nothing was written outside, which is the whole claim.
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
  });

  it('never creates a symlink, and says how many it refused', async () => {
    const result = await extractTarGz(
      bytes(
        archive([
          { name: 'acme-app-abc123/real.ts', body: 'x' },
          { name: 'acme-app-abc123/escape', type: '2', linkName: '/etc/passwd' },
          { name: 'acme-app-abc123/also', type: '1', linkName: 'real.ts' },
        ]),
      ),
      dest,
      { stripComponents: 1 },
    );

    expect(await walk(dest)).toEqual(['real.ts']);
    expect(result.skippedLinks).toBe(2);
  });

  it.each([
    [
      'the per-file cap',
      { fileBytes: 8 },
      [{ name: 'r/big.bin', body: 'x'.repeat(64) }],
      /per-file limit/,
    ],
    [
      'the whole-workspace cap',
      { workspaceBytes: 16 },
      [
        { name: 'r/a.ts', body: 'x'.repeat(12) },
        { name: 'r/b.ts', body: 'x'.repeat(12) },
      ],
      /workspace limit/,
    ],
    [
      'the file-count cap',
      { files: 1 },
      [
        { name: 'r/a.ts', body: 'a' },
        { name: 'r/b.ts', body: 'b' },
      ],
      /file/,
    ],
    [
      'the download cap',
      { archiveBytes: 32 },
      [{ name: 'r/a.ts', body: 'a'.repeat(4096) }],
      /download limit/,
    ],
  ])('refuses the archive at %s', async (_label, limits, entries, message) => {
    await expect(
      extractTarGz(bytes(archive(entries as Entry[])), dest, {
        stripComponents: 1,
        limits,
      }),
    ).rejects.toThrow(message);
  });

  it('refuses a header that declares a size it does not carry', async () => {
    // The zip-bomb shape that no byte cap sees: a 2 GiB declaration with an
    // empty body. The per-file cap catches it before a single byte is read.
    await expect(
      extractTarGz(
        bytes(archive([{ name: 'r/huge.bin', declaredSize: 2 * 1024 * 1024 * 1024 }])),
        dest,
        { stripComponents: 1 },
      ),
    ).rejects.toThrow(/per-file limit/);
  });

  it('keeps the real caps generous enough for a real repository', () => {
    // A guard on the constants themselves: shrinking one of these without
    // meaning to would start refusing ordinary customers' repositories.
    expect(DEFAULT_EXTRACTION_LIMITS.archiveBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    expect(DEFAULT_EXTRACTION_LIMITS.workspaceBytes).toBeGreaterThan(
      DEFAULT_EXTRACTION_LIMITS.archiveBytes,
    );
    expect(DEFAULT_EXTRACTION_LIMITS.files).toBeGreaterThanOrEqual(20_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a project with no connected repository', () => {
  const unseal = () => 'unused';

  it('is reported as unavailable with the thing to configure, not as a failure', async () => {
    const outcome = await materialiseRepoWorkspace({
      runId: 'run_1',
      repo: {
        repoFullName: null,
        repoInstallationId: null,
        defaultBranch: 'main',
        commitSha: null,
      },
      unseal,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.why).toMatch(/no connected repository/i);
    // And the sentence a test carries never reads as a verdict on the app.
    const message = repoUnavailableMessage(
      'UNIT_GEN',
      outcome.kind === 'unavailable' ? outcome.why : '',
    );
    expect(message).toMatch(/was not evaluated/);
    expect(message).toMatch(/No result here is a verdict on your application/);
  });

  it('refuses a repository name that is not a GitHub owner/name', async () => {
    const outcome = await materialiseRepoWorkspace({
      runId: 'run_1',
      repo: {
        repoFullName: 'https://evil.example.com/acme/app',
        repoInstallationId: '42',
        defaultBranch: 'main',
        commitSha: null,
      },
      unseal,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe('unavailable');
  });

  it('says so when the deployment has no GitHub App at all', async () => {
    const saved = { ...process.env };
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_ENC;
    try {
      const outcome = await materialiseRepoWorkspace({
        runId: 'run_1',
        repo: {
          repoFullName: 'acme/app',
          repoInstallationId: '42',
          defaultBranch: 'main',
          commitSha: null,
        },
        unseal,
        signal: new AbortController().signal,
      });

      expect(outcome.kind).toBe('unavailable');
      expect(outcome.kind === 'unavailable' && outcome.why).toMatch(/GITHUB_APP_ID/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('declares exactly the types that ALWAYS need a checkout', () => {
    expect([...REPO_DEPENDENT_TEST_TYPES].sort()).toEqual(['INTEGRATION', 'MUTATION', 'UNIT_GEN']);
    // E2E is conditional, not exempt — see testNeedsRepository below. Reading
    // this set alone is what made a suite of only CONTRACT/PROTOCOL/MOBILE or
    // declared-command E2E tests materialise nothing and then skip all of them.
    expect(REPO_DEPENDENT_TEST_TYPES.has('E2E')).toBe(false);
  });

  describe('testNeedsRepository', () => {
    it('is true for the three unconditional types whatever the spec says', () => {
      for (const type of ['INTEGRATION', 'UNIT_GEN', 'MUTATION'] as const) {
        expect(testNeedsRepository({ type, spec: null })).toBe(true);
        expect(testNeedsRepository({ type, spec: { command: '' } })).toBe(true);
      }
    });

    it('reads a CONTRACT document reference rather than its key', () => {
      // A pact broker URL touches no file; the same field as a path does.
      expect(
        testNeedsRepository({
          type: 'CONTRACT',
          spec: { kind: 'pact', pactPath: 'https://broker.example.com/pacts/x' },
        }),
      ).toBe(false);
      expect(
        testNeedsRepository({ type: 'CONTRACT', spec: { kind: 'pact', pactPath: 'pacts/web.json' } }),
      ).toBe(true);
      expect(
        testNeedsRepository({
          type: 'CONTRACT',
          spec: { kind: 'openapi', specPath: 'http://localhost:3000/openapi.json' },
        }),
      ).toBe(false);
      expect(
        testNeedsRepository({ type: 'CONTRACT', spec: { kind: 'openapi', specPath: 'docs/api.yaml' } }),
      ).toBe(true);
    });

    it('is false for a PROTOCOL test on server reflection, true for one with a .proto', () => {
      expect(testNeedsRepository({ type: 'PROTOCOL', spec: { target: 'localhost:50051' } })).toBe(
        false,
      );
      expect(
        testNeedsRepository({ type: 'PROTOCOL', spec: { protoPath: 'proto/orders.proto' } }),
      ).toBe(true);
      expect(testNeedsRepository({ type: 'PROTOCOL', spec: { importPaths: ['proto'] } })).toBe(true);
      expect(testNeedsRepository({ type: 'PROTOCOL', spec: { importPaths: [] } })).toBe(false);
    });

    it('exempts APPIUM and requires a checkout for the CLI mobile drivers', () => {
      expect(testNeedsRepository({ type: 'MOBILE', spec: { driver: 'APPIUM' } })).toBe(false);
      for (const driver of ['MAESTRO', 'DETOX', 'ESPRESSO', 'XCUITEST']) {
        expect(testNeedsRepository({ type: 'MOBILE', spec: { driver } })).toBe(true);
      }
    });

    it('needs a checkout for an E2E or SMOKE test that declares its own command', () => {
      expect(testNeedsRepository({ type: 'E2E', spec: { steps: [] } })).toBe(false);
      expect(testNeedsRepository({ type: 'E2E', spec: { command: 'npx cypress run' } })).toBe(true);
      expect(testNeedsRepository({ type: 'SMOKE', spec: { command: 'npx cypress run' } })).toBe(true);
      // Whitespace is not a command: `routeFor` trims before deciding too, and
      // disagreeing with it would materialise a repo for the harness route.
      expect(testNeedsRepository({ type: 'E2E', spec: { command: '   ' } })).toBe(false);
    });

    it('over-reports rather than under-reports when the spec cannot be read', () => {
      // A skip does not block a gate, so guessing "no checkout" turns a suite
      // green over work nobody did. A needless download is the cheaper mistake.
      expect(testNeedsRepository({ type: 'MOBILE', spec: undefined })).toBe(true);
      expect(testNeedsRepository({ type: 'MOBILE', spec: 'not an object' })).toBe(true);
      expect(testNeedsRepository({ type: 'MOBILE', spec: [] })).toBe(true);
    });

    it('is false for the types that drive the application over HTTP', () => {
      for (const type of ['API', 'VISUAL', 'ACCESSIBILITY', 'LOAD', 'SECURITY_SMOKE'] as const) {
        expect(testNeedsRepository({ type, spec: { anything: true } })).toBe(false);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a project with a repository', () => {
  /** A real key, because the App JWT is really signed. */
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  let installations = 0;

  beforeEach(() => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    // Only the installation-token call reaches the global fetch; the archive
    // download is injected below.
    vi.stubGlobal('fetch', async () => {
      installations += 1;
      return new Response(
        JSON.stringify({
          token: 'ghs_test',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  const download =
    (body: Buffer | null, status = 200): ArchiveDownloader =>
    async ({ url, token }) => {
      // The ref under test ends up in the path, and the credential must be in
      // the header rather than the URL.
      expect(url).not.toContain(token);
      return { ok: status === 200, status, body: body ? bytes(body) : null };
    };

  it('checks the run commit out into a temp workspace, and removes it on cleanup', async () => {
    const outcome = await materialiseRepoWorkspace({
      runId: 'run_abcdef12',
      repo: {
        repoFullName: 'acme/app',
        repoInstallationId: `${900 + installations}`,
        defaultBranch: 'main',
        commitSha: 'a'.repeat(40),
      },
      unseal: () => 'unused',
      signal: new AbortController().signal,
      download: download(
        archive([
          { name: 'acme-app-aaa/package.json', body: '{}' },
          { name: 'acme-app-aaa/src/index.ts', body: 'export {};' },
        ]),
      ),
    });

    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    // Never inside, or beside, the worker's own source tree.
    expect(outcome.workspace.root.startsWith(tmpdir())).toBe(true);
    expect(outcome.workspace.root.includes(process.cwd())).toBe(false);
    expect(outcome.workspace.source).toBe(`acme/app@${'a'.repeat(40)}`);
    expect(await walk(outcome.workspace.root)).toEqual(['package.json', 'src/index.ts']);

    await outcome.cleanup();
    expect(existsSync(outcome.workspace.root)).toBe(false);
    // Cleanup is called from a `finally`, including after an earlier cleanup.
    await expect(outcome.cleanup()).resolves.toBeUndefined();
  });

  it('removes the directory when the archive is refused part-way', async () => {
    const outcome = await materialiseRepoWorkspace({
      runId: 'run_abcdef12',
      repo: {
        repoFullName: 'acme/app',
        repoInstallationId: `${950 + installations}`,
        defaultBranch: 'main',
        commitSha: null,
      },
      unseal: () => 'unused',
      signal: new AbortController().signal,
      limits: { files: 1 },
      download: download(
        archive([
          { name: 'acme-app-aaa/a.ts', body: 'a' },
          { name: 'acme-app-aaa/b.ts', body: 'b' },
        ]),
      ),
    });

    expect(outcome.kind).toBe('unavailable');
    // A half-extracted tree looks like the repository and is not, so it goes.
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith('qaai-repo-abcdef12-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('reports a GitHub refusal as unavailable rather than throwing', async () => {
    const outcome = await materialiseRepoWorkspace({
      runId: 'run_abcdef12',
      repo: {
        repoFullName: 'acme/app',
        repoInstallationId: `${980 + installations}`,
        defaultBranch: 'main',
        commitSha: null,
      },
      unseal: () => 'unused',
      signal: new AbortController().signal,
      download: download(null, 404),
    });

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.why).toMatch(/404/);
  });
});
