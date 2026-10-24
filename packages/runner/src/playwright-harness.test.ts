/**
 * Harness tests for the one thing it must refuse to do.
 *
 * The end-to-end behaviour of this harness — it really spawns Playwright and
 * really parses its report — is exercised by determinism.test.ts. This file
 * covers what was added for per-test auth profiles, and deliberately covers it
 * without a browser, because the interesting cases are all refusals that
 * happen before anything is spawned.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * A run had ONE storage state: the first auth profile on the environment,
 * applied to every test. A test can name its own `authProfileId`, so a suite
 * holds an admin test and a member test — and under one session at most one of
 * them was running as the role it claims.
 *
 * The dangerous half is not the mix-up, it is the FALLBACK. If the profile's
 * session cannot be produced, running the spec anyway runs it logged out, an
 * anonymous browser hitting an admin page gets a login redirect, and an
 * assertion on "no error banner" passes. A green tick on a permission test
 * nobody is running is worse than any failure, so this harness refuses.
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactSink, ExecutableTest, RunContext } from '@qaai/shared';
import { missingRoleSession, runPlaywrightSpec, storageStateFileName } from './playwright-harness.js';
import { attachAuthProfile } from './run-workspace.js';

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function context(over: { storageState?: unknown; profileId?: string | null } = {}): RunContext {
  const ctx: RunContext = {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://127.0.0.1:1',
    secrets: {},
    storageState: over.storageState ?? null,
    artifacts,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, step: () => {} },
    signal: new AbortController().signal,
    determinism: {
      freezeClockAt: null,
      randomSeed: 1,
      waitForNetworkIdle: false,
      retryOnce: false,
    },
  };
  return attachAuthProfile(ctx, over.profileId ?? null);
}

function test(authProfileId: string | null, authProfileRequired = false): ExecutableTest {
  return {
    id: 'test_1',
    name: 'an admin can delete a member',
    type: 'E2E',
    code: 'await page.goto("/admin");',
    filePath: 'admin/delete-member.spec.ts',
    spec: {},
    timeoutMs: 30_000,
    quarantined: false,
    tags: [],
    authProfileId,
    authProfileRequired,
  };
}

const SESSION = { cookies: [{ name: 'sid', value: 'x' }], origins: [] };

describe('the session a spec runs under', () => {
  it('is keyed by profile, so one profile is one file and two are never one', () => {
    expect(storageStateFileName('prof_admin')).toBe(storageStateFileName('prof_admin'));
    expect(storageStateFileName('prof_admin')).not.toBe(storageStateFileName('prof_member'));
    expect(storageStateFileName(null)).toBe('storage-state.json');
  });

  it('never lets a profile id become a path', () => {
    // A profile id is a cuid, but it ends up as a real filename.
    expect(storageStateFileName('../../etc/passwd')).toBe('storage-state-.._.._etc_passwd.json');
    expect(storageStateFileName('a/b')).not.toContain('/');
  });
});

describe('a test that names an auth profile', () => {
  it('is satisfied when the run supplied that profile and a session', () => {
    expect(missingRoleSession(context({ storageState: SESSION, profileId: 'p1' }), test('p1'))).toBeNull();
  });

  it('is refused when the run supplied a DIFFERENT profile', () => {
    // The admin test and the member test in one suite: this is the case where
    // the spec would have run as somebody else and could not know.
    expect(
      missingRoleSession(context({ storageState: SESSION, profileId: 'p2' }), test('p1')),
    ).toEqual({ declared: 'p1', supplied: 'p2' });
  });

  it('is refused when the run supplied the profile but no session', () => {
    // An SSO bypass TOKEN signs in "successfully" and produces no browser
    // session. Accepting that would be the anonymous-pass defect exactly.
    expect(missingRoleSession(context({ profileId: 'p1' }), test('p1'))).toEqual({
      declared: 'p1',
      supplied: 'p1',
    });
  });

  it('is refused when the binding was deleted but the intent survived', () => {
    /*
     * `Test.authProfileId` is nulled by a foreign key when the profile is
     * deleted; `authProfileRequired` is a separate column precisely so that
     * deletion cannot erase the fact that a role was asked for. A test left in
     * that state is a broken binding, and running it signed out is the quiet
     * pass this whole mechanism exists to prevent.
     */
    expect(missingRoleSession(context(), test(null, true))).toEqual({
      declared: null,
      supplied: null,
    });
  });

  it('accepts a required-role test when the run default supplied a session', () => {
    // The intent is satisfied by whatever session the run has: the test said
    // "not signed out", not "signed in as one specific person".
    expect(missingRoleSession(context({ storageState: SESSION }), test(null, true))).toBeNull();
  });

  it('leaves a test that named no profile alone', () => {
    // The default path, unchanged: a test that claimed no role is not lying
    // about one, with or without a cached session on the environment.
    expect(missingRoleSession(context(), test(null))).toBeNull();
    expect(missingRoleSession(context({ storageState: SESSION }), test(null))).toBeNull();
    expect(missingRoleSession(context({ storageState: SESSION, profileId: 'p1' }), test(null))).toBeNull();
  });
});

describe('running a spec whose role could not be produced', () => {
  it('fails with the reason instead of executing it anonymously', async () => {
    const execution = await runPlaywrightSpec(context(), test('prof_admin'));

    // FAILED, not SKIPPED: a skip does not block a gate, and a permission test
    // that quietly stopped running would keep merging green.
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('prof_admin');
    expect(execution.errorMessage).toMatch(/NOT executed anonymously/);
    expect(execution.errorMessage).toMatch(/Auth profiles/);
    // Nothing ran, so there is nothing to report but the refusal.
    expect(execution.steps).toEqual([]);
    expect(execution.videoKey).toBeNull();
    expect(execution.traceKey).toBeNull();
  });

  it('fails a required-role test whose profile was deleted, naming the fix', async () => {
    const execution = await runPlaywrightSpec(context(), test(null, true));

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/requiring a signed-in role/);
    expect(execution.errorMessage).toMatch(/Re-bind the test/);
  });

  it('names the profile it was given instead, when it was given one', async () => {
    const execution = await runPlaywrightSpec(
      context({ storageState: SESSION, profileId: 'prof_member' }),
      test('prof_admin'),
    );

    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toMatch(/supplied prof_member instead/);
  });
});
