/**
 * PER-PRINCIPAL BROWSER CONTEXTS.
 *
 * The defect these tests pin: ONE `storageState` per run meant one cookie jar
 * per run, so "user A reads user B's invoice" was INEXPRESSIBLE and had to be
 * approximated by asking anonymously — which every application denies, so the
 * check passed everywhere and never found anything.
 *
 * NO REAL FILESYSTEM AND NO BROWSER. `writePrincipalSessions` takes its two
 * filesystem calls as an injected narrow interface, so the logic that decides
 * WHICH principals get a file, under WHICH names, with WHICH bytes is tested
 * against a fake and the one adapter at the call site has no branches left to
 * get wrong.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINCIPAL_NAME, principal } from '@qaai/shared';
import type { RunContext } from '@qaai/shared';
import {
  principalStateFiles,
  storageStateFileName,
  writePrincipalSessions,
} from './playwright-harness.js';
import { principalStorageStateFileName } from './principals.js';

/** Records every write instead of performing one. */
function fakeWriter(): {
  writes: Array<{ path: string; contents: string }>;
  mkdirs: string[];
  writer: Parameters<typeof writePrincipalSessions>[2];
} {
  const writes: Array<{ path: string; contents: string }> = [];
  const mkdirs: string[] = [];
  return {
    writes,
    mkdirs,
    writer: {
      mkdir: async (path) => {
        mkdirs.push(path);
      },
      writeFile: async (path, contents) => {
        writes.push({ path, contents });
      },
    },
  };
}

const session = (storageState: unknown | null, name: string, role: string | null) => ({
  principal: principal({
    name,
    kind: storageState === null ? ('ANONYMOUS' as const) : ('PERSISTENT' as const),
    lifecycle: 'ACTIVE' as const,
    ...(role !== null ? { role } : {}),
  }),
  storageState,
  expiresAtIso: null,
});

const ctxWith = (sessions: RunContext['sessions'], storageState: unknown | null = null) =>
  ({ storageState, sessions, authProfileId: null }) as Pick<
    RunContext,
    'storageState' | 'sessions' | 'authProfileId'
  >;

describe('two principals get two isolated contexts', () => {
  it('writes a SEPARATE file per principal, which is what two cookie jars means', async () => {
    const fake = fakeWriter();
    const written = await writePrincipalSessions(
      ctxWith({
        holder: session({ cookies: [{ name: 's', value: 'holder-jar' }] }, 'holder', 'member'),
        subject: session({ cookies: [{ name: 's', value: 'subject-jar' }] }, 'subject', 'member'),
      }),
      '/ws',
      fake.writer,
    );

    expect([...written.keys()].sort()).toEqual(['holder', 'subject']);

    const holder = written.get('holder')!;
    const subject = written.get('subject')!;
    // The claim that matters: no two principals can ever name the same file.
    expect(holder.canonical).not.toBe(subject.canonical);
    expect(holder.playwrightConvention).not.toBe(subject.playwrightConvention);

    // And the bytes differ, so the two contexts are genuinely different
    // identities rather than two names for one session.
    const holderBytes = fake.writes.filter((w) => w.path.includes('holder')).map((w) => w.contents);
    const subjectBytes = fake.writes
      .filter((w) => w.path.includes('subject'))
      .map((w) => w.contents);
    expect(holderBytes.length).toBeGreaterThan(0);
    expect(subjectBytes.length).toBeGreaterThan(0);
    for (const bytes of holderBytes) expect(bytes).toContain('holder-jar');
    for (const bytes of subjectBytes) expect(bytes).toContain('subject-jar');
    expect(new Set(holderBytes).has(subjectBytes[0]!)).toBe(false);
  });

  it('writes each session under BOTH names, because the generated spec reads the other one', async () => {
    const fake = fakeWriter();
    await writePrincipalSessions(
      ctxWith({ approver: session({ cookies: [] }, 'approver', 'admin') }),
      '/ws',
      fake.writer,
    );
    const paths = fake.writes.map((w) => w.path);
    // The runner's own contract — what `PrincipalContextPlan` promises.
    expect(paths.some((p) => p.endsWith(principalStorageStateFileName('approver')))).toBe(true);
    // Playwright's documented convention — what `actorStateFile` in
    // packages/agent/src/multi-actor.ts emits into the CUSTOMER's spec. Writing
    // only the first makes that spec read a missing file, run anonymously, and
    // PASS, which is the false green this whole path exists to remove.
    expect(paths.some((p) => p.endsWith('playwright/.auth/approver.json'))).toBe(true);
  });

  it('gives a principal with a NULL session NO FILE, rather than the default one', async () => {
    const fake = fakeWriter();
    const written = await writePrincipalSessions(
      ctxWith({
        [DEFAULT_PRINCIPAL_NAME]: session({ cookies: [{ name: 's', value: 'real' }] }, 'default', null),
        anon: session(null, 'anon', null),
      }),
      '/ws',
      fake.writer,
    );
    expect(written.has('anon')).toBe(false);
    // The dangerous version of this bug: the anonymous baseline inheriting an
    // authenticated cookie jar, which makes every authorization probe pass.
    expect(fake.writes.some((w) => w.path.includes('anon'))).toBe(false);
    expect(fake.writes.every((w) => !w.path.includes('anon'))).toBe(true);
  });

  it('keeps the SINGLE-principal run behaving exactly as it did, via the normaliser', async () => {
    const fake = fakeWriter();
    // No `sessions` at all — the shape every existing caller passes.
    const written = await writePrincipalSessions(
      { storageState: { cookies: [{ name: 's', value: 'legacy' }] }, authProfileId: null },
      '/ws',
      fake.writer,
    );
    // `runSessions` synthesises the default entry from the legacy field, so the
    // default principal is present and is the ONLY one.
    expect([...written.keys()]).toEqual([DEFAULT_PRINCIPAL_NAME]);
    for (const write of fake.writes) expect(write.contents).toContain('legacy');
  });

  it('records nothing at all when the run resolved no session', async () => {
    const fake = fakeWriter();
    const written = await writePrincipalSessions(
      { storageState: null, authProfileId: null },
      '/ws',
      fake.writer,
    );
    expect(written.size).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it('cannot be made to write outside the workspace by a hostile principal name', async () => {
    const fake = fakeWriter();
    await writePrincipalSessions(
      ctxWith({ '../../etc/passwd': session({ cookies: [] }, '../../etc/passwd', null) }),
      '/ws',
      fake.writer,
    );
    // A principal name is scenario-authored text that becomes a real path.
    for (const write of fake.writes) {
      expect(write.path.startsWith('/ws/')).toBe(true);
      expect(write.path).not.toContain('etc/passwd');
    }
  });
});

describe('the two filename conventions stay distinguishable', () => {
  it('never collides a principal file with the legacy per-PROFILE file', () => {
    // `storageStateFileName` is keyed on an auth profile id and
    // `principalStorageStateFileName` on a principal NAME. Two principals may
    // legitimately share one profile, so the two must not be the same function.
    expect(principalStateFiles('admin').canonical).not.toBe(storageStateFileName('admin'));
  });

  it('is a pure function of the name, so two runs name the same files', () => {
    expect(principalStateFiles('holder')).toEqual(principalStateFiles('holder'));
  });

  it('never lets a sanitised name become empty and collide', () => {
    // The genuinely-empty case, which is the only one the fallback is for:
    // `''` sanitises to `''`, and a path of `playwright/.auth/.json` would be a
    // hidden file every unnamed principal shared.
    expect(principalStateFiles('').playwrightConvention).toBe('playwright/.auth/unnamed.json');
    // `'///'` sanitises to `'___'`, which is NOT empty — so the fallback does
    // not fire and must not. Pinned because my first version of this test
    // asserted it did, and the difference is exactly the kind of thing that
    // makes a sanitiser silently collide two names later.
    expect(principalStateFiles('///').playwrightConvention).toBe('playwright/.auth/___.json');
    expect(principalStateFiles('///').playwrightConvention).not.toContain('/..');
  });
});
