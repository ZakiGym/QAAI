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
import {
  botProtectionRefusal,
  challengeNote,
  challengeSignalIn,
  CHALLENGE_SIGNALS,
  extraHttpHeadersSource,
  missingRoleSession,
  resolveEnvironmentHeaders,
  runPlaywrightSpec,
  storageStateFileName,
  type EnvironmentAccessPolicy,
} from './playwright-harness.js';
import { attachAuthProfile } from './run-workspace.js';

const artifacts: ArtifactSink = {
  put: async () => 'key',
  putFile: async () => 'key',
  get: async () => null,
  putPersistent: async () => 'key',
};

function context(
  over: {
    storageState?: unknown;
    profileId?: string | null;
    /** This environment's vault, for the header-resolution cases. */
    secrets?: Record<string, string>;
  } = {},
): RunContext {
  const ctx: RunContext = {
    runId: 'run_1',
    orgId: 'org_1',
    projectId: 'proj_1',
    environmentId: 'env_1',
    baseUrl: 'http://127.0.0.1:1',
    secrets: over.secrets ?? {},
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

// ─── Bot protection and the headers that are the only way in ─────────────────

/**
 * The defect these cover: an application behind reCAPTCHA, Turnstile, hCaptcha
 * or a WAF cannot be signed into by ANY auth profile kind, so its whole
 * authenticated surface is unenumerable — and the zero that produces was
 * reported as a testing failure rather than an access problem.
 *
 * Every case here is about telling two opposite facts apart: "we never reached
 * your application" versus "we reached it and it failed". Nothing in the module
 * under test solves, replays or evades a challenge, and `CHALLENGE_SIGNALS` is
 * asserted below to be attribution markers only.
 */

const BYPASS: EnvironmentAccessPolicy = {
  provider: 'TURNSTILE',
  bypassMode: 'SIGNED_BYPASS_HEADER',
  bypassHeaderName: 'x-edge-bypass',
  bypassSecretName: 'EDGE_BYPASS',
};

/** A value distinctive enough that finding it anywhere is proof of a leak. */
const BYPASS_VALUE = 'tk_live_7f3a9e2b_do_not_log_me';

describe('resolving an environment’s headers', () => {
  it('sends a plain header inline and a credential one from the vault', () => {
    const resolved = resolveEnvironmentHeaders(
      {
        provider: 'NONE',
        bypassMode: 'NOT_CONFIGURED',
        extraHeaders: [
          { name: 'X-Environment', value: 'staging' },
          { name: 'Authorization', secretName: 'BEARER' },
        ],
      },
      { BEARER: 'Bearer abc' },
    );

    expect(resolved.headers).toEqual({ 'X-Environment': 'staging', Authorization: 'Bearer abc' });
    expect(resolved.refusals).toEqual([]);
    expect(resolved.names).toEqual(['X-Environment', 'Authorization']);
    // The provenance is what the generated config is built from.
    expect(resolved.entries).toEqual([
      { name: 'X-Environment', literal: 'staging', secretName: null },
      { name: 'Authorization', literal: null, secretName: 'BEARER' },
    ]);
  });

  it('REFUSES an Authorization header with an inline value, whatever the casing', () => {
    // The settings screen renders this row. An inline bearer token there is a
    // bearer token on a screen and in every export of it.
    for (const name of ['Authorization', 'authorization', 'AUTHORIZATION']) {
      const resolved = resolveEnvironmentHeaders(
        { provider: 'NONE', bypassMode: 'NOT_CONFIGURED', extraHeaders: [{ name, value: 'Bearer x' }] },
        {},
      );
      expect(resolved.headers).toEqual({});
      expect(resolved.refusals).toHaveLength(1);
      expect(resolved.refusals[0]?.reason).toBe('INLINE_CREDENTIAL');
      // The refused value must not survive into the reported reason.
      expect(JSON.stringify(resolved)).not.toContain('Bearer x');
    }
  });

  it('claims the bypass name FIRST, so a stray header cannot shadow it', () => {
    /*
     * The mutation this kills is resolving the extra headers before the bypass.
     * It compiles, and it means a duplicate entry overwrites the credential the
     * customer's edge requires — every request is then challenged and the
     * failure is reported as a defect in their application.
     */
    const resolved = resolveEnvironmentHeaders(
      { ...BYPASS, extraHeaders: [{ name: 'X-Edge-Bypass', value: 'nonsense' }] },
      { EDGE_BYPASS: BYPASS_VALUE },
    );

    expect(resolved.headers).toEqual({ 'x-edge-bypass': BYPASS_VALUE });
    expect(resolved.refusals.map((r) => r.reason)).toEqual(['DUPLICATE_NAME']);
    expect(resolved.refusals[0]?.removesTheBypass).toBe(false);
  });

  it('reports a missing bypass secret as the loss of the bypass, by NAME', () => {
    const resolved = resolveEnvironmentHeaders(BYPASS, {});

    expect(resolved.headers).toEqual({});
    expect(resolved.refusals).toHaveLength(1);
    expect(resolved.refusals[0]?.reason).toBe('MISSING_SECRET');
    // The flag is what promotes this to a refusal to execute at all.
    expect(resolved.refusals[0]?.removesTheBypass).toBe(true);
    expect(resolved.refusals[0]?.secretName).toBe('EDGE_BYPASS');
  });

  it('refuses a bypass that names no vault entry, and says which half is missing', () => {
    const noSecret = resolveEnvironmentHeaders({ ...BYPASS, bypassSecretName: null }, {});
    expect(noSecret.refusals[0]?.reason).toBe('BYPASS_INCOMPLETE');
    expect(noSecret.refusals[0]?.detail).toContain('which vault entry holds its value');

    const noName = resolveEnvironmentHeaders({ ...BYPASS, bypassHeaderName: '  ' }, {});
    expect(noName.refusals[0]?.reason).toBe('BYPASS_INCOMPLETE');
    expect(noName.refusals[0]?.detail).toContain('which header name your edge accepts');
    expect(noName.refusals[0]?.removesTheBypass).toBe(true);
  });

  it('refuses a bypass header name that is not a legal header name', () => {
    // `bypassHeaderName` is a plain column, so a row written outside
    // `botProtectionSchema` can hold anything — and this name reaches a
    // generated TypeScript file and a child process's environment.
    const resolved = resolveEnvironmentHeaders(
      { ...BYPASS, bypassHeaderName: 'x-bad\nname' },
      { EDGE_BYPASS: BYPASS_VALUE },
    );
    expect(resolved.headers).toEqual({});
    expect(resolved.refusals[0]?.reason).toBe('UNREADABLE');
    expect(resolved.refusals[0]?.removesTheBypass).toBe(true);
  });

  it('lets ONE bad entry cost only itself, not every header beside it', () => {
    /*
     * The mutation: one `environmentExtraHeadersSchema.safeParse` over the
     * whole array. It is the obvious implementation and it means one typo
     * silently drops every working header on the environment.
     */
    const resolved = resolveEnvironmentHeaders(
      {
        provider: 'NONE',
        bypassMode: 'NOT_CONFIGURED',
        extraHeaders: [
          { name: 'X-One', value: 'a' },
          { name: 'X-Two', value: 'b', secretName: 'BOTH' },
          { name: 'X-Three', value: 'c' },
        ],
      },
      {},
    );

    expect(resolved.names).toEqual(['X-One', 'X-Three']);
    expect(resolved.refusals.map((r) => r.header)).toEqual(['X-Two']);
    expect(resolved.refusals[0]?.reason).toBe('UNREADABLE');
  });

  it('refuses a stored blob that is not a list, and keeps the bypass it already had', () => {
    const resolved = resolveEnvironmentHeaders(
      { ...BYPASS, extraHeaders: { 'X-One': 'a' } },
      { EDGE_BYPASS: BYPASS_VALUE },
    );
    expect(resolved.names).toEqual(['x-edge-bypass']);
    expect(resolved.refusals[0]?.reason).toBe('UNREADABLE');
    expect(resolved.refusals[0]?.header).toBe('(all)');
    expect(resolved.refusals[0]?.removesTheBypass).toBe(false);
  });

  it('reports a missing NON-bypass secret without claiming the bypass was lost', () => {
    const resolved = resolveEnvironmentHeaders(
      {
        provider: 'NONE',
        bypassMode: 'NOT_CONFIGURED',
        extraHeaders: [{ name: 'X-Tenant', secretName: 'TENANT' }],
      },
      {},
    );
    expect(resolved.refusals[0]?.reason).toBe('MISSING_SECRET');
    expect(resolved.refusals[0]?.removesTheBypass).toBe(false);
  });
});

describe('deciding whether a run may proceed', () => {
  it('never refuses from a NONE provider, with or without headers', () => {
    expect(botProtectionRefusal({ provider: 'NONE', bypassMode: 'NOT_CONFIGURED' })).toBeNull();
  });

  it('refuses a named provider with no legitimate route past it, and names the remedy', () => {
    const refusal = botProtectionRefusal({ provider: 'RECAPTCHA', bypassMode: 'NOT_CONFIGURED' });
    expect(refusal).not.toBeNull();
    expect(refusal?.provider).toBe('RECAPTCHA');
    // The two facts this product cannot afford to merge.
    expect(refusal?.message).toMatch(/Nothing was measured/);
    expect(refusal?.message).toMatch(/NOT a statement that the surface behind the wall is empty/);
    expect(refusal?.remedy).toMatch(/test keys/);
  });

  it('lets a configured bypass through once it actually resolved', () => {
    const resolved = resolveEnvironmentHeaders(BYPASS, { EDGE_BYPASS: BYPASS_VALUE });
    expect(botProtectionRefusal(BYPASS, resolved.refusals)).toBeNull();
  });

  it('refuses a bypass that is configured and UNUSABLE, which is the same wall', () => {
    /*
     * The mutation: decide the refusal from `reachabilityFromPolicy` alone. A
     * row with bypassMode SIGNED_BYPASS_HEADER reads as "a route past it is
     * configured", so the run proceeds with no header, every request is
     * challenged, and the customer is told their application failed.
     */
    const resolved = resolveEnvironmentHeaders(BYPASS, {});
    const refusal = botProtectionRefusal(BYPASS, resolved.refusals);
    expect(refusal).not.toBeNull();
    expect(refusal?.message).toMatch(/was NOT executed/);
    expect(refusal?.message).toMatch(/EDGE_BYPASS/);
    expect(refusal?.message).toMatch(/Nothing was measured/);
  });

  it('does not refuse over a header that was never the way in', () => {
    const resolved = resolveEnvironmentHeaders(
      { provider: 'NONE', bypassMode: 'NOT_CONFIGURED', extraHeaders: [{ name: 'X-T', secretName: 'NOPE' }] },
      {},
    );
    expect(resolved.refusals).toHaveLength(1);
    expect(
      botProtectionRefusal({ provider: 'NONE', bypassMode: 'NOT_CONFIGURED' }, resolved.refusals),
    ).toBeNull();
  });
});

describe('attributing a challenge that was actually seen', () => {
  it('attributes every provider in the table from its own documented marker', () => {
    for (const candidate of CHALLENGE_SIGNALS) {
      const seen = challengeSignalIn(`Timed out waiting for selector\n  at ${candidate.signal}/x`);
      expect(seen?.provider).toBe(candidate.provider);
      expect(seen?.signal).toBe(candidate.signal);
    }
  });

  it('matches whatever the casing, because a URL in a stack trace is not normalised', () => {
    expect(challengeSignalIn('GET https://CHALLENGES.CLOUDFLARE.COM/turnstile')?.provider).toBe(
      'TURNSTILE',
    );
  });

  it('REFUSES to attribute anything when it saw no marker', () => {
    /*
     * The mutation: a generic signal like "access denied" or "403" in the
     * table. It would attribute a WAF to every forbidden response in the world,
     * and a false attribution is worse than an unattributed failure — it moves
     * the fault onto the customer's edge for something our own credentials did.
     */
    expect(challengeSignalIn('403 Forbidden: access denied by the application')).toBeNull();
    expect(challengeSignalIn('expect(received).toBe(expected)')).toBeNull();
    expect(challengeSignalIn('')).toBeNull();
  });

  it('carries no solver, endpoint or token format — markers only', () => {
    // Rule 9, asserted rather than trusted: nothing in this table is a thing
    // you could send, only a thing you could recognise.
    for (const candidate of CHALLENGE_SIGNALS) {
      expect(candidate.signal).not.toMatch(/solve|bypass|token|siteverify|secret/i);
    }
  });

  it('says the result is UNDETERMINED rather than re-deciding the verdict', () => {
    const note = challengeNote({ provider: 'WAF', signal: 'awswaf.com' });
    expect(note).toMatch(/UNDETERMINED/);
    expect(note).toMatch(/may have been evaluated against a challenge page/);
    expect(note).toContain('awswaf.com');
  });
});

describe('running a spec against an environment we cannot reach', () => {
  it('reports SKIPPED with the remedy and measures nothing', async () => {
    const execution = await runPlaywrightSpec(context(), test(null), {
      access: { provider: 'TURNSTILE', bypassMode: 'NOT_CONFIGURED' },
    });

    // SKIPPED and not FAILED: the application was never reached, so a failure
    // would be a claim about code nobody executed.
    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/behind TURNSTILE/);
    expect(execution.errorMessage).toMatch(/Nothing was measured/);
    expect(execution.steps).toEqual([]);
    expect(execution.videoKey).toBeNull();
  });

  it('refuses before a browser, when the bypass secret is gone', async () => {
    const execution = await runPlaywrightSpec(context(), test(null), { access: BYPASS });

    expect(execution.status).toBe('SKIPPED');
    expect(execution.errorMessage).toMatch(/was NOT executed/);
    // The disclosure is on the RESULT, not only in a log.
    expect(execution.console.map((entry) => entry.text).join('\n')).toMatch(
      /Header refused \(MISSING_SECRET\)/,
    );
  });

  it('leaves a run with no access policy exactly as it was', async () => {
    // Absent means NOT PROBED. It must not become "nothing is in the way" and
    // it must not become a refusal either.
    const execution = await runPlaywrightSpec(context(), test('prof_admin'));
    expect(execution.status).toBe('FAILED');
    expect(execution.errorMessage).toContain('prof_admin');
  });

  it('never puts a header VALUE on the result, only its name', async () => {
    const execution = await runPlaywrightSpec(
      context({ secrets: { EDGE_BYPASS: BYPASS_VALUE } }),
      test('prof_admin'),
      { access: BYPASS },
    );

    // The role gap is refused first, so nothing ran — and the value is still
    // nowhere in the serialised result.
    expect(JSON.stringify(execution)).not.toContain(BYPASS_VALUE);
  });
});

describe('the extraHTTPHeaders the generated config carries', () => {
  it('inlines a plain value and reads a credential from the vault entry’s own name', () => {
    /*
     * The two halves of the rule. A literal is a value the schema has already
     * refused to let be a credential, so it is safe on disk. A vault-backed
     * value becomes a `process.env[...]` read in the child, which `childEnv`
     * has already filled with `ctx.secrets` — so no credential is written to a
     * file AND no new environment variable exists, because the only name read
     * is the customer's own vault entry.
     */
    const source = extraHttpHeadersSource([
      { name: 'X-Environment', literal: 'staging', secretName: null },
      { name: 'x-edge-bypass', literal: null, secretName: 'EDGE_BYPASS' },
    ]);

    expect(source).toBe('{ "X-Environment": "staging", "x-edge-bypass": process.env["EDGE_BYPASS"] }');
  });

  it('NEVER writes a resolved credential into the source', () => {
    const resolved = resolveEnvironmentHeaders(BYPASS, { EDGE_BYPASS: BYPASS_VALUE });
    const source = extraHttpHeadersSource(resolved.entries);

    // The value resolved fine — it is in `headers` — and is still absent here.
    expect(resolved.headers['x-edge-bypass']).toBe(BYPASS_VALUE);
    expect(source).not.toContain(BYPASS_VALUE);
    expect(source).toContain('process.env["EDGE_BYPASS"]');
  });

  it('quotes a vault entry name, which is an unconstrained customer string', () => {
    /*
     * A header NAME is validated against the HTTP token grammar upstream. A
     * vault entry name is not constrained at all, and it becomes source code
     * here — so it is stringified rather than interpolated. Interpolating it
     * bare is the mutation this kills, and it turns a secret name into
     * arbitrary code inside the customer's own run.
     */
    const source = extraHttpHeadersSource([
      { name: 'x-t', literal: null, secretName: 'a"]; process.exit(1); //' },
    ]);
    /*
     * Proved by PARSING the subscript back out, not by eyeballing the string: a
     * correctly escaped name round-trips through JSON.parse to the name that
     * went in, and the unescaped form cannot, because the quote would close the
     * literal and leave `; process.exit(1); //` as code inside the customer's
     * own run. A plain string comparison would also pass on an escaping scheme
     * that merely looked different.
     */
    const subscript = /process\.env\[(.*)\] \}$/.exec(source)?.[1];
    expect(subscript).toBeDefined();
    expect(JSON.parse(subscript as string)).toBe('a"]; process.exit(1); //');
    // And the unescaped form is genuinely absent from the source.
    expect(source).not.toContain('a"];');
  });

  it('is an empty object when nothing is configured, so the config stays valid', () => {
    expect(extraHttpHeadersSource([])).toBe('{  }');
  });
});
