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
  collectRuntimeObservation,
  extraHttpHeadersSource,
  missingRoleSession,
  observedNetworkEntries,
  observedSurface,
  OBSERVATION_STATES,
  parseObservationLines,
  resolveEnvironmentHeaders,
  runPlaywrightSpec,
  runtimeFindings,
  runtimeObserverEpilogue,
  RUNTIME_FINDING_CAP,
  RUNTIME_INVARIANTS,
  RUNTIME_OBSERVATION_CAPS,
  RUNTIME_OBSERVER_MARKER,
  RUNTIME_VOCABULARY_PRESENCE,
  specUsesBrowser,
  storageStateFileName,
  urlTemplate,
  type EnvironmentAccessPolicy,
  type RuntimeFindingResult,
  type RuntimeObservation,
  type RuntimeObservationSource,
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

/*
 * ── Runtime observation ─────────────────────────────────────────────────────
 *
 * THE DEFECT: `TestExecution.network` was `[]` on every path and `findings` was
 * `[]` on all three, so the only question the product could answer was "which
 * crawled surface does a test MENTION" — a regex over test source — and a GREEN
 * test over a THROWING application was reported as covered and healthy.
 *
 * None of these tests launch a browser or touch the network. The harness takes
 * its observation through {@link RuntimeObservationSource}, and the whole
 * classification layer is pure functions over NDJSON, so a fake satisfies the
 * seam in one line and every rule below is pinned against hand-written records.
 * The one thing a fake cannot prove — that the injected epilogue compiles and
 * that Chromium really emits these events — was verified against a live
 * Chromium while this was written, and the facts it established are recorded in
 * the comments on the code (`responseEnd` is -1 at the response event; the JSON
 * reporter emits no `pw:api` steps at all).
 */

/** NDJSON, as the injected observer writes it: one JSON object per line. */
function nd(...records: ReadonlyArray<Record<string, unknown>>): string[] {
  return records.map((record) => JSON.stringify(record));
}

const ATTACH = { t: 'attach', test: 'checkout › pays', variant: 'chromium' };

function surfaceOf(lines: readonly string[], baseUrl = 'https://app.test'): RuntimeObservation {
  const { records, malformed } = parseObservationLines(lines);
  return observedSurface(records, {
    testId: 'test_1',
    baseUrl,
    malformed,
    availability: { state: 'OBSERVED', reason: null },
  });
}

function findingsOf(
  lines: readonly string[],
  specCode = 'await expect(page).toHaveURL("/ok");',
  baseUrl = 'https://app.test',
): RuntimeFindingResult {
  const { records } = parseObservationLines(lines);
  return runtimeFindings(records, { baseUrl, specCode });
}

describe('the runtime vocabulary', () => {
  it('declares every invariant once, in all four places', () => {
    /*
     * The pattern this codebase enforces for a vocabulary with a write path.
     * Eight GateRule kinds once shipped unsaveable for two slices because only
     * the compiler-enforced half of this existed, and `check:wiring` cannot see
     * that class of defect. The `Record<RuntimeInvariant, …>` maps are the
     * compile-time half — a ninth invariant that forgets its code does not
     * compile — and this is the run-time half: the maps and the array agree,
     * member for member, with no extras in either direction.
     */
    const invariants = [...RUNTIME_INVARIANTS];
    expect(new Set(invariants).size).toBe(invariants.length);
    expect(Object.keys(RUNTIME_VOCABULARY_PRESENCE.invariants).sort()).toEqual(
      [...invariants].sort(),
    );

    const states = [...OBSERVATION_STATES];
    expect(new Set(states).size).toBe(states.length);
    expect(Object.keys(RUNTIME_VOCABULARY_PRESENCE.states).sort()).toEqual([...states].sort());
  });

  it('gives every invariant a distinct, prefixed, filterable code', () => {
    /*
     * Driven through the PUBLIC path — one record per invariant — rather than
     * read off the private map, so this also proves each invariant is actually
     * reachable from an observation. All eight are carried under the SECURITY
     * FindingKind because `FINDING_KINDS` has no RUNTIME member, so a gate
     * configured on SECURITY has to be able to tell a page error from a missing
     * CSP header: the `runtime.` prefix and a DISTINCT code per invariant are
     * what make that possible, and two invariants sharing a code would also
     * silently merge two families in the dedupe above.
     */
    const page = 'https://app.test/checkout';
    const req = (status: number, url = 'https://app.test/api/x', from = page) => ({
      t: 'req',
      method: 'GET',
      url,
      status,
      rt: 'fetch',
      nav: false,
      chain: [],
      from,
    });
    const drivers: Array<Record<string, unknown>> = [
      { t: 'pageerror', name: 'TypeError', message: 'threw', from: page },
      { t: 'pageerror', name: 'Error', message: 'Uncaught (in promise) nope', from: page },
      { t: 'console', level: 'error', text: 'a plain console error', from: page },
      { t: 'reqfail', method: 'GET', url: 'https://app.test/api/y', err: 'net::ERR', from: page },
      req(404),
      req(500),
      req(200, 'http://cdn.insecure.test/a.png'),
      {
        t: 'console',
        level: 'error',
        text: 'Refused to load: it violates the following Content Security Policy directive',
        from: page,
      },
    ];

    const codes = new Set(
      drivers.flatMap((driver) => findingsOf(nd(ATTACH, driver)).findings.map((f) => f.code)),
    );
    expect(codes.size).toBe(RUNTIME_INVARIANTS.length);
    expect([...codes].every((code) => code.startsWith('runtime.'))).toBe(true);

    // Every one of them lands on a kind the Finding type actually has.
    for (const driver of drivers) {
      for (const finding of findingsOf(nd(ATTACH, driver)).findings) {
        expect(finding.kind).toBe('SECURITY');
        expect(finding.location).not.toBe('');
      }
    }
  });
});

describe('url templates', () => {
  it('replaces identifiers and keeps real route words', () => {
    const t = (raw: string) => urlTemplate(raw, 'https://app.test').template;
    expect(t('https://app.test/orders/12345')).toBe('/orders/:id');
    expect(t('https://app.test/u/550e8400-e29b-41d4-a716-446655440000/edit')).toBe('/u/:id/edit');
    expect(t('https://app.test/m/clh3k2j1x0000qwertyuiopas')).toBe('/m/:id');
    /*
     * The mutation this kills: an eager id pattern. If `checkout` or `settings`
     * matched, every route would collapse into `/:id` and the runtime surface
     * would look complete because the extractor got WORSE — which is exactly
     * what the UNKNOWN-is-not-a-gap rule exists to prevent elsewhere.
     */
    expect(t('https://app.test/checkout')).toBe('/checkout');
    expect(t('https://app.test/settings/billing')).toBe('/settings/billing');
    expect(t('https://app.test/api/v2/members')).toBe('/api/v2/members');
  });

  it('DROPS the query string, because a query string holds credentials', () => {
    const { template, hadQuery } = urlTemplate(
      'https://app.test/reset?token=SUPERSECRET&email=a@b.c',
      'https://app.test',
    );
    expect(template).toBe('/reset');
    expect(template).not.toContain('SUPERSECRET');
    // Reported, not just done: the caller turns `hadQuery` into a disclosed
      // count, because a silently truncated URL is still a silent cap.
    expect(hadQuery).toBe(true);
  });

  it('keeps the host when the call left the application', () => {
    // "This test called Stripe" is a different and more interesting fact than
    // "this test called /v1/charges".
    expect(urlTemplate('https://api.stripe.com/v1/charges', 'https://app.test').template).toBe(
      'https://api.stripe.com/v1/charges',
    );
    expect(urlTemplate('https://app.test/v1/charges', 'https://app.test').template).toBe(
      '/v1/charges',
    );
  });

  it('never leaves a query on a URL it could not parse', () => {
    const { template } = urlTemplate('::not a url::?token=SUPERSECRET', '');
    expect(template).not.toContain('SUPERSECRET');
    expect(template).not.toContain('?');
  });
});

describe('the observed surface', () => {
  it('records the navigation the test performed, with its redirect chain', () => {
    const surface = surfaceOf(
      nd(
        ATTACH,
        {
          t: 'req',
          method: 'GET',
          url: 'https://app.test/start',
          status: 302,
          rt: 'document',
          nav: true,
          chain: [],
          from: '',
        },
        {
          t: 'req',
          method: 'GET',
          url: 'https://app.test/checkout',
          status: 200,
          rt: 'document',
          nav: true,
          chain: ['https://app.test/start'],
          from: '',
        },
      ),
    );

    /*
     * THE REDIRECT FOLD. Playwright reports a redirected navigation TWICE —
     * once as the 302 and again as the 200 carrying the 302 in its
     * `redirectedFrom()` chain. The mutation this kills is counting both:
     * that reports two navigations where the test made one, and puts an
     * intermediate hop into the surface as if the test had landed on it.
     */
    expect(surface.navigations).toHaveLength(1);
    expect(surface.navigations[0]).toMatchObject({
      redirectChain: ['/start'],
      finalUrl: '/checkout',
      status: 200,
    });
    // Both hops are still in the REQUEST list — the fold is about navigations,
    // not about pretending the 302 never happened.
    expect(surface.requests.map((request) => request.template)).toEqual(['/start', '/checkout']);
  });

  it('keeps a redirect the browser never followed, instead of folding it away', () => {
    // An off-site hand-off: the 302 appears in nobody's chain, and dropping it
    // would lose the last thing the test did.
    const surface = surfaceOf(
      nd(ATTACH, {
        t: 'req',
        method: 'GET',
        url: 'https://app.test/sso',
        status: 302,
        rt: 'document',
        nav: true,
        chain: [],
        from: '',
      }),
    );
    expect(surface.navigations.map((n) => n.finalUrl)).toEqual(['/sso']);
  });

  it('records a client-side route change, with NO status rather than a made-up one', () => {
    const surface = surfaceOf(nd(ATTACH, { t: 'nav', url: 'https://app.test/cart/items' }));
    expect(surface.navigations).toHaveLength(1);
    expect(surface.navigations[0]?.finalUrl).toBe('/cart/items');
    // An SPA push has no HTTP response of its own. 200 here would be invented.
    expect(surface.navigations[0]?.status).toBeNull();
  });

  it('ignores about:blank, which is where every context starts', () => {
    expect(surfaceOf(nd(ATTACH, { t: 'nav', url: 'about:blank' })).navigations).toEqual([]);
  });

  it('attributes everything to the test AND the variant', () => {
    const surface = surfaceOf(
      nd(
        { t: 'attach', test: 'a', variant: 'chromium' },
        { t: 'ctl', action: 'click', locator: "getByRole('button')" },
        { t: 'attach', test: 'a', variant: 'firefox' },
        { t: 'ctl', action: 'click', locator: "getByRole('button')" },
      ),
    );
    /*
     * The same click in two browsers is two observations, not one with a count
     * of two: a control that works in chromium and throws in firefox is the
     * whole point of running a matrix, and collapsing the variant would hide it.
     */
    expect(surface.controls).toHaveLength(2);
    expect(surface.controls.map((c) => c.variant).sort()).toEqual(['chromium', 'firefox']);
    expect(surface.attribution).toHaveLength(2);
  });

  it('names an unnamed project `default` rather than the empty string', () => {
    // Measured: `testInfo.project.name` is '' when the config declares no
    // projects, and '' is not a variant a reader can act on.
    const surface = surfaceOf(nd({ t: 'attach', test: 'a', variant: '' }, { t: 'nav', url: 'https://app.test/x' }));
    expect(surface.navigations[0]?.variant).toBe('default');
  });

  it('records the locator that resolved a control, and counts repeats', () => {
    const surface = surfaceOf(
      nd(
        ATTACH,
        { t: 'ctl', action: 'click', locator: "getByRole('button', { name: 'Pay' })" },
        { t: 'ctl', action: 'click', locator: "getByRole('button', { name: 'Pay' })" },
        { t: 'ctl', action: 'fill', locator: "locator('#amount')" },
      ),
    );
    expect(surface.controls).toHaveLength(2);
    expect(surface.controls[0]).toMatchObject({
      action: 'click',
      locator: "getByRole('button', { name: 'Pay' })",
      count: 2,
    });
    expect(surface.controls[1]?.action).toBe('fill');
  });

  it('attaches a measured duration, and leaves an unmeasurable one NULL', () => {
    const surface = surfaceOf(
      nd(
        ATTACH,
        {
          t: 'req',
          method: 'POST',
          url: 'https://app.test/api/pay',
          status: 200,
          rt: 'fetch',
          nav: false,
          chain: [],
          from: 'https://app.test/checkout',
        },
        { t: 'timing', method: 'POST', url: 'https://app.test/api/pay', ms: 37 },
        /*
         * The SAME method and the SAME url as the timed request above, on
         * purpose: with a different method the correlation key never collides
         * and the guard below is never exercised. The first version of this
         * test used GET here, and the mutation that drops the
         * `status === null` guard SURVIVED it.
         */
        {
          t: 'reqfail',
          method: 'POST',
          url: 'https://app.test/api/pay',
          err: 'net::ERR_ABORTED',
          from: 'https://app.test/checkout',
        },
        { t: 'ws', url: 'wss://app.test/live' },
      ),
    );

    const paid = surface.requests.find((r) => r.status === 200);
    expect(paid?.ms).toBe(37);
    const failed = surface.requests.find((r) => r.transport === 'OTHER');
    expect(failed?.method).toBe('POST');
    expect(failed?.ms).toBeNull();

    /*
     * THE MUTATION THIS KILLS: correlating a duration onto a request that never
     * completed. A failed request and a WebSocket emit no `requestfinished`, so
     * neither has a duration — and borrowing the successful POST's 37ms for the
     * failed GET to the SAME URL would invent a measurement for a request that
     * did not happen. Null, not zero, and not a neighbour's number.
     */
    for (const request of surface.requests) {
      if (request.status === null) expect(request.ms).toBeNull();
    }
  });

  it('discloses the query strings it dropped, as a count and a reason', () => {
    const surface = surfaceOf(
      nd(ATTACH, {
        t: 'req',
        method: 'GET',
        url: 'https://app.test/reset?token=SUPERSECRET',
        status: 200,
        rt: 'fetch',
        nav: false,
        chain: [],
        from: 'https://app.test/',
      }),
    );
    const cap = surface.caps.find((c) => c.kind === 'query');
    expect(cap?.dropped).toBe(1);
    expect(cap?.reason).toMatch(/token|session id/);
    expect(JSON.stringify(surface)).not.toContain('SUPERSECRET');
  });

  it('SUMS the browser-side cap across the tests in a file, once per kind', () => {
    /*
     * A spec file holds many tests and each one writes its own cap line. The
     * mutation this kills is appending a cap entry per line: the reader then
     * sees the same ceiling reported four times with four partial counts, and
     * no single number saying how much of the defect list is missing.
     */
    const surface = surfaceOf(
      nd(
        { t: 'attach', test: 'one', variant: 'chromium' },
        { t: 'cap', k: 'console', limit: 100, dropped: 7 },
        { t: 'attach', test: 'two', variant: 'chromium' },
        { t: 'cap', k: 'console', limit: 100, dropped: 5 },
      ),
    );
    const console = surface.caps.filter((c) => c.kind === 'console');
    expect(console).toHaveLength(1);
    expect(console[0]?.dropped).toBe(12);
    expect(console[0]?.limit).toBe(100);
    expect(console[0]?.reason).toContain('12');
  });

  it('says nothing about a cap that did not bite', () => {
    // Zero dropped is not a cap that bit, and a warning for it would train the
    // reader to ignore the ones that did.
    const surface = surfaceOf(nd(ATTACH, { t: 'cap', k: 'console', limit: 100, dropped: 0 }));
    expect(surface.caps).toEqual([]);
  });

  it('counts every line it could not read, and drops to PARTIAL', () => {
    const surface = surfaceOf([
      JSON.stringify(ATTACH),
      'not json at all',
      '{"t":"unknown-kind"}',
      JSON.stringify({ t: 'nav', url: 'https://app.test/x' }),
    ]);
    expect(surface.navigations).toHaveLength(1);
    expect(surface.availability.state).toBe('PARTIAL');
    const cap = surface.caps.find((c) => c.kind === 'malformed');
    expect(cap?.dropped).toBe(2);
    // PARTIAL and not OBSERVED: a truncated observation file and a quiet
    // application look identical from the outside, and only this tells them apart.
    expect(surface.availability.reason).toMatch(/unreadable/);
  });

  it('caps its own distinct records and discloses the overflow', () => {
    const many = [
      ATTACH,
      ...Array.from({ length: RUNTIME_OBSERVATION_CAPS.ctl + 9 }, (_unused, index) => ({
        t: 'ctl',
        action: 'click',
        locator: `locator('#b${index}')`,
      })),
    ];
    const surface = surfaceOf(nd(...many));
    expect(surface.controls).toHaveLength(RUNTIME_OBSERVATION_CAPS.ctl);
    const cap = surface.caps.find((c) => c.kind === 'ctl');
    expect(cap?.dropped).toBe(9);
    expect(cap?.limit).toBe(RUNTIME_OBSERVATION_CAPS.ctl);
  });
});

describe('runtime-invariant findings', () => {
  it('reports a throwing application on a test whose assertions PASSED', () => {
    /*
     * THE WHOLE POINT OF REQUIREMENT 2. The test is green; the page threw. Both
     * are facts and both get reported. `status` is never touched by a finding —
     * the same rule leaks.ts follows — so a green run stays green and stops
     * being described as healthy.
     */
    const { findings } = findingsOf(
      nd(ATTACH, {
        t: 'pageerror',
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'total')",
        from: 'https://app.test/checkout',
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'runtime.page-error',
      severity: 'SERIOUS',
      location: '/checkout',
    });
    expect(findings[0]?.message).toContain('TypeError');
  });

  it('does NOT report a 4xx the test deliberately asserts on', () => {
    /*
     * THE FALSE FINDING THIS PREVENTS. A negative test — "a member cannot
     * delete another member's booking" — drives the app until it gets a 403 and
     * then asserts on it. The 403 is the PASS CONDITION. Reporting it as a
     * defect on a green test is how a team learns to ignore everything QAAI
     * says, so the suppression is deliberate, and it is DISCLOSED rather than
     * silent: a suppressed finding nobody is told about is also a lie.
     */
    const lines = nd(ATTACH, {
      t: 'req',
      method: 'DELETE',
      url: 'https://app.test/api/bookings/77',
      status: 403,
      rt: 'fetch',
      nav: false,
      chain: [],
      from: 'https://app.test/bookings',
    });

    const asserted = findingsOf(lines, 'expect(response.status()).toBe(403);');
    expect(asserted.findings).toEqual([]);
    const disclosure = asserted.caps.find((c) => c.reason.includes('403'));
    expect(disclosure?.dropped).toBe(1);
    expect(disclosure?.reason).toMatch(/NOT reported/);

    // And the same 403 in a test that says nothing about 403 IS a finding —
    // the mutation "suppress every 4xx" would make this one disappear.
    const unasserted = findingsOf(lines, 'await expect(page).toHaveURL("/bookings");');
    expect(unasserted.findings).toHaveLength(1);
    expect(unasserted.findings[0]?.code).toBe('runtime.http-4xx');
  });

  it('reports LOW CONFIDENCE rather than a confident finding it cannot stand behind', () => {
    /*
     * With no spec source there is no way to tell a deliberate 403 from a
     * defect. The instruction is explicit: report low confidence rather than a
     * false finding. So the finding survives — losing it would hide a real 500
     * — at the floor severity and with the reason in the message, where the
     * reader sees it.
     */
    const { findings } = findingsOf(
      nd(ATTACH, {
        t: 'req',
        method: 'GET',
        url: 'https://app.test/api/x',
        status: 500,
        rt: 'fetch',
        nav: false,
        chain: [],
        from: 'https://app.test/',
      }),
      '',
    );
    expect(findings[0]?.severity).toBe('MINOR');
    expect(findings[0]?.message).toContain('LOW CONFIDENCE');

    // With a readable spec the same 500 is SERIOUS. The mutation "always report
    // low confidence" would make every real 500 look like a guess.
    const readable = findingsOf(
      nd(ATTACH, {
        t: 'req',
        method: 'GET',
        url: 'https://app.test/api/x',
        status: 500,
        rt: 'fetch',
        nav: false,
        chain: [],
        from: 'https://app.test/',
      }),
      'await page.goto("/");',
    );
    expect(readable.findings[0]?.severity).toBe('SERIOUS');
    expect(readable.findings[0]?.message).not.toContain('LOW CONFIDENCE');
  });

  it('does not report one defect twice when the browser narrates it', () => {
    /*
     * Measured against Chromium: a non-2xx subresource produces BOTH a response
     * event and a console error reading "Failed to load resource: the server
     * responded with a status of 500". Emitting both doubles the apparent
     * finding count of any app with one flaky endpoint. The echo is suppressed
     * and the suppression is disclosed.
     */
    const { findings, caps } = findingsOf(
      nd(
        ATTACH,
        {
          t: 'req',
          method: 'POST',
          url: 'https://app.test/api/pay',
          status: 500,
          rt: 'fetch',
          nav: false,
          chain: [],
          from: 'https://app.test/checkout',
        },
        {
          t: 'console',
          level: 'error',
          text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
          from: 'https://app.test/checkout',
        },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('runtime.http-5xx');
    expect(caps.find((c) => c.reason.includes('restating'))?.dropped).toBe(1);
  });

  it('classifies a CSP violation and a mixed-content block out of console text', () => {
    /*
     * Both reach the harness ONLY as console text. `securitypolicyviolation` is
     * the documented DOM event for CSP, and reading it would mean injecting a
     * binding — an observable global — into the customer's own application to
     * measure it. This file will not do that, so the console text is the source
     * and the limitation is stated rather than hidden.
     */
    const { findings } = findingsOf(
      nd(
        ATTACH,
        {
          t: 'console',
          level: 'error',
          text: "Refused to load the script 'https://evil.test/a.js' because it violates the following Content Security Policy directive",
          from: 'https://app.test/',
        },
        {
          t: 'console',
          level: 'error',
          text: 'Mixed Content: The page was loaded over HTTPS but requested an insecure resource',
          from: 'https://app.test/',
        },
      ),
    );
    expect(findings.map((f) => f.code)).toEqual([
      'runtime.csp-violation',
      'runtime.mixed-content',
    ]);
    expect(findings.every((f) => f.severity === 'SERIOUS')).toBe(true);
  });

  it('finds mixed content STRUCTURALLY, even when the browser logged nothing', () => {
    // Stronger than the text match above and independent of it: an http://
    // subresource pulled into an https:// document is mixed content whatever
    // Chromium chose to say about it.
    const { findings } = findingsOf(
      nd(ATTACH, {
        t: 'req',
        method: 'GET',
        url: 'http://cdn.insecure.test/logo.png',
        status: 200,
        rt: 'image',
        nav: false,
        chain: [],
        from: 'https://app.test/checkout',
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('runtime.mixed-content');

    // And an http:// resource on an http:// page is not mixed content. The
    // mutation "any http:// request is mixed content" would file a finding on
    // every local development run.
    expect(
      findingsOf(
        nd(ATTACH, {
          t: 'req',
          method: 'GET',
          url: 'http://cdn.insecure.test/logo.png',
          status: 200,
          rt: 'image',
          nav: false,
          chain: [],
          from: 'http://app.test/checkout',
        }),
        'await page.goto("/");',
        'http://app.test',
      ).findings,
    ).toEqual([]);
  });

  it('labels an unhandled rejection when, and only when, the text says so', () => {
    /*
     * Measured: Playwright delivers an unhandled promise rejection through
     * `pageerror` with NO marker distinguishing it from an uncaught throw. So
     * the specific label is only claimed when the message carries it, and an
     * unlabelled rejection is reported as a page error — a correct severity
     * under a coarser code, rather than a guess dressed up as a fact.
     */
    const rejected = findingsOf(
      nd(ATTACH, {
        t: 'pageerror',
        name: 'Error',
        message: 'Uncaught (in promise) Error: checkout failed',
        from: 'https://app.test/',
      }),
    );
    expect(rejected.findings[0]?.code).toBe('runtime.unhandled-rejection');

    const thrown = findingsOf(
      nd(ATTACH, {
        t: 'pageerror',
        name: 'Error',
        message: 'checkout failed',
        from: 'https://app.test/',
      }),
    );
    expect(thrown.findings[0]?.code).toBe('runtime.page-error');
  });

  it('reports a request that never completed, with no status invented for it', () => {
    const { findings } = findingsOf(
      nd(ATTACH, {
        t: 'reqfail',
        method: 'GET',
        url: 'https://app.test/api/slow',
        err: 'net::ERR_CONNECTION_REFUSED',
        from: 'https://app.test/',
      }),
    );
    expect(findings[0]).toMatchObject({
      code: 'runtime.request-failed',
      location: 'GET /api/slow',
    });
    expect(findings[0]?.message).toContain('net::ERR_CONNECTION_REFUSED');
  });

  it('ignores a console warning, and reports a console error', () => {
    const warned = findingsOf(
      nd(ATTACH, { t: 'console', level: 'warning', text: 'deprecated', from: 'https://app.test/' }),
    );
    expect(warned.findings).toEqual([]);
    const errored = findingsOf(
      nd(ATTACH, { t: 'console', level: 'error', text: 'boom', from: 'https://app.test/' }),
    );
    expect(errored.findings).toHaveLength(1);
  });

  it('dedupes with a count, and caps each invariant with the overflow disclosed', () => {
    const noisy = [
      ATTACH,
      ...Array.from({ length: 3 }, () => ({
        t: 'console',
        level: 'error',
        text: 'the same error again',
        from: 'https://app.test/',
      })),
      ...Array.from({ length: RUNTIME_FINDING_CAP + 4 }, (_unused, index) => ({
        t: 'console',
        level: 'error',
        text: `distinct error ${index}`,
        from: 'https://app.test/',
      })),
    ];
    const { findings, caps } = findingsOf(nd(...noisy));

    expect(findings.find((f) => f.message.startsWith('the same error again'))?.message).toContain(
      'seen 3×',
    );
    expect(findings).toHaveLength(RUNTIME_FINDING_CAP);
    // An undisclosed truncation of a DEFECT LIST is the one cap this product
    // may never apply quietly.
    const cap = caps.find((c) => c.limit === RUNTIME_FINDING_CAP);
    expect(cap?.dropped).toBeGreaterThan(0);
    expect(cap?.reason).toContain('not listed');
  });

  it('never carries a body, a header, a cookie or a typed value', () => {
    /*
     * Asserted over a hostile record set rather than trusted to a comment. The
     * observer records the ACTION and the LOCATOR of a `fill`, never its
     * argument, because a login test types a password — and a query string is
     * dropped before it is ever written.
     */
    const lines = nd(
      ATTACH,
      {
        t: 'req',
        method: 'POST',
        url: 'https://app.test/login?next=/admin&token=SECRET_QUERY',
        status: 200,
        rt: 'fetch',
        nav: false,
        chain: [],
        from: 'https://app.test/login',
      },
      { t: 'ctl', action: 'fill', locator: "getByLabel('Password')" },
    );
    const blob = JSON.stringify({ surface: surfaceOf(lines), found: findingsOf(lines) });
    expect(blob).not.toContain('SECRET_QUERY');
    expect(blob).not.toContain('next=');
    // The locator survives — it is in the customer's own test source already.
    expect(blob).toContain("getByLabel('Password')");
  });
});

describe('the network pane the cockpit reads', () => {
  it('carries no response body, ever', () => {
    const { entries } = observedNetworkEntries(
      surfaceOf(
        nd(ATTACH, {
          t: 'req',
          method: 'POST',
          url: 'https://app.test/api/pay',
          status: 500,
          rt: 'fetch',
          nav: false,
          chain: [],
          from: 'https://app.test/',
        }),
      ),
    );
    expect(entries).toHaveLength(1);
    // Null and not '' — an empty string reads as "the body was empty", which is
    // a claim about the response. This observer never looked.
    expect(entries[0]?.responseBodySnippet).toBeNull();
    expect(entries[0]).toMatchObject({ method: 'POST', url: '/api/pay', status: 500 });
  });

  it('counts the entries whose 0 is not a measurement', () => {
    /*
     * `NetworkEntry.durationMs` is a non-nullable number, so an unmeasured
     * duration has to be written as 0 — and a 0 nobody explained is the "null
     * that became 0" this product cannot ship. So the unmeasured ones are
     * counted and the count is disclosed by the caller.
     */
    const { entries, untimed } = observedNetworkEntries(
      surfaceOf(
        nd(
          ATTACH,
          {
            t: 'req',
            method: 'GET',
            url: 'https://app.test/a',
            status: 200,
            rt: 'fetch',
            nav: false,
            chain: [],
            from: 'https://app.test/',
          },
          { t: 'timing', method: 'GET', url: 'https://app.test/a', ms: 12 },
          { t: 'ws', url: 'wss://app.test/live' },
        ),
      ),
    );
    expect(entries.find((e) => e.url === '/a')?.durationMs).toBe(12);
    expect(untimed).toBe(1);
  });
});

describe('what the harness says when it did not watch', () => {
  const lines = nd(ATTACH, { t: 'nav', url: 'https://app.test/x' });

  async function collect(
    source: RuntimeObservationSource,
    notApplicable: string | null = null,
  ): Promise<Awaited<ReturnType<typeof collectRuntimeObservation>>> {
    return collectRuntimeObservation({
      testId: 'test_1',
      dir: '/fake/observations',
      baseUrl: 'https://app.test',
      specCode: 'await page.goto("/x");',
      source,
      notApplicable,
    });
  }

  it('reports UNAVAILABLE, never "clean", when the observer wrote nothing', async () => {
    /*
     * THE LIE THIS REFUSES. A test whose app threw four exceptions and a test
     * QAAI could not watch both produce `findings: []`. Only this field tells
     * them apart, so an absent observer says UNAVAILABLE with its reason and the
     * reason says in words that it is not a verdict on the application.
     */
    const { observation, console } = await collect({ read: async () => null });
    expect(observation.availability.state).toBe('UNAVAILABLE');
    expect(observation.availability.reason).toMatch(/NOT a statement that the application/);
    expect(console.some((entry) => entry.text.includes('UNAVAILABLE'))).toBe(true);
  });

  it('distinguishes "it watched and saw nothing" from "it did not watch"', async () => {
    // `[]` and `null` out of the source are different claims and only one of
    // them is "we did not measure". Collapsing them is the whole defect.
    const empty = await collect({ read: async () => [] });
    expect(empty.observation.availability.state).toBe('OBSERVED');
    expect(empty.observation.availability.reason).toBeNull();
    expect(empty.observation.requests).toEqual([]);
  });

  it('reports NOT_APPLICABLE for a spec that drives no browser', async () => {
    const { observation } = await collect(
      { read: async () => null },
      'this spec references no page',
    );
    expect(observation.availability.state).toBe('NOT_APPLICABLE');
    expect(observation.availability.reason).toBe('this spec references no page');
  });

  it('never lets an observation problem change a verdict', async () => {
    // An observer that throws must degrade to UNAVAILABLE, not propagate: a
    // reporting problem must never lose a run.
    const { observation, findings } = await collect({
      read: async () => {
        throw new Error('disk gone');
      },
    });
    expect(observation.availability.state).toBe('UNAVAILABLE');
    expect(findings).toEqual([]);
  });

  it('folds a real observation through the same seam', async () => {
    const { observation, findings } = await collect({ read: async () => lines });
    expect(observation.availability.state).toBe('OBSERVED');
    expect(observation.navigations.map((n) => n.finalUrl)).toEqual(['/x']);
    expect(findings).toEqual([]);
  });
});

describe('the observer injected into the spec', () => {
  const source = runtimeObserverEpilogue('/tmp/run-1/observations');

  it('is skipped entirely for a spec that drives no browser', () => {
    /*
     * The epilogue destructures the `page` fixture and requesting `page`
     * LAUNCHES A BROWSER. Injecting it into an API-only spec would add a
     * browser launch the test never asked for and would fail it outright on a
     * worker with no Chromium — so such a spec is left byte-identical.
     */
    expect(specUsesBrowser('test("x", async ({ page }) => { await page.goto("/"); });')).toBe(true);
    expect(specUsesBrowser('test("x", async ({ context }) => {});')).toBe(true);
    expect(specUsesBrowser('test("x", async ({ request }) => { await request.get("/api"); });')).toBe(
      false,
    );
  });

  it('records the ACTION and the LOCATOR of a fill, never its argument', () => {
    // A login test types a password. The patched method writes `action` and
    // `String(this)` and then calls through with `...args` untouched — the
    // arguments are never serialised.
    expect(source).toContain("__qaaiWrite({ t: 'ctl', action: action, locator: String(this)");
    expect(source).toContain('return original.apply(this, args);');
    /*
     * Asserted over the CODE, with the comments stripped: the first version of
     * this check matched the very comment that explains why args[0] is not
     * recorded, so it would have passed over an implementation that recorded
     * it. `args` now has to appear exactly twice — the parameter and the
     * call-through — which leaves no third site able to serialise it.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/args\[0\]|JSON\.stringify\(args/);
    expect(code.match(/\bargs\b/g)).toEqual(['args', 'args']);
  });

  it('reaches the locator prototype through the PUBLIC api', () => {
    // Not `playwright-core/lib/client/locator.js`: an internal path is not an
    // entry point and breaks on a patch release. This one is reachable from
    // `page.locator()`, which is documented.
    expect(source).toContain("Object.getPrototypeOf(page.locator('html'))");
    expect(source).not.toContain('playwright-core/lib');
  });

  it('strips the query string before anything reaches disk', () => {
    // Done in the browser process, not on the way out: a token must not exist
    // in a file in between, even for the moment before the harness reads it.
    expect(source).toContain('function __qaaiSafeUrl');
    expect(source).toContain("const cut = text.indexOf('?');");
  });

  it('cannot fail the test it is observing', () => {
    /*
     * Every listener body, the writer and the patch are wrapped. A throw out of
     * QAAI's own injected code would be reported as a defect in the customer's
     * application, which is the worst failure mode available here.
     */
    expect(source.split('} catch {}').length - 1).toBeGreaterThanOrEqual(8);
    expect(source).toContain("/* Observation must never fail a customer's test. */");
  });

  it('resets its counters per TEST, so one file does not double-count a cap', () => {
    expect(source).toContain('__qaaiObs.counts = { nav: 0, req: 0, ctl: 0, console: 0 };');
    expect(source).toContain("__qaaiObserveTest.afterEach");
  });

  it('inlines the directory as a string literal rather than a new env var', () => {
    /*
     * `har.ts` passes its report directory the same way. An environment
     * variable would be new configuration for something that is not
     * configurable, and the path is QAAI's own temp directory — but it is still
     * JSON-stringified, because a path that becomes source code and is
     * interpolated bare is arbitrary code inside the customer's own run.
     */
    const hostile = runtimeObserverEpilogue('a"; process.exit(1); //');
    const subscript = /dir: (".*?"),\n/.exec(hostile)?.[1];
    expect(subscript).toBeDefined();
    expect(JSON.parse(subscript as string)).toBe('a"; process.exit(1); //');
    expect(hostile).not.toContain('a"; process.exit(1); //,');
  });

  it('carries the caps it enforces, so the browser side and this file agree', () => {
    expect(source).toContain(JSON.stringify(RUNTIME_OBSERVATION_CAPS));
    expect(source).toContain(RUNTIME_OBSERVER_MARKER);
  });

  it('writes one file per process, because Playwright loads a spec many times', () => {
    // Playwright loads the spec in the collection process AND in every worker.
    // Two writers on one path interleave half-lines, which the parser would
    // then count as malformed — real data lost to a filename.
    expect(source).toContain("'obs-' + process.pid + '-' + Date.now() + '.ndjson'");
  });
});

describe('the paths that never reach a browser', () => {
  it('says on the RESULT that an unexecuted spec observed nothing', async () => {
    /*
     * `findings: []` on a refusal must not read as "no defects found". The
     * refusal already explains why the test did not run; this adds, in the
     * channel the reader is already looking at, that nothing below is a
     * statement about the application.
     */
    const execution = await runPlaywrightSpec(context(), test('prof_admin'));
    expect(execution.status).toBe('FAILED');
    expect(execution.findings).toEqual([]);
    expect(execution.console.map((entry) => entry.text).join('\n')).toMatch(
      /Runtime observation NOT_APPLICABLE: The spec was not executed/,
    );
  });

  it('says the same when the environment was never reached', async () => {
    const execution = await runPlaywrightSpec(context(), test(null), {
      access: { provider: 'TURNSTILE', bypassMode: 'NOT_CONFIGURED' },
    });
    expect(execution.status).toBe('SKIPPED');
    expect(execution.console.map((entry) => entry.text).join('\n')).toMatch(
      /Runtime observation NOT_APPLICABLE: The environment was never reached/,
    );
  });
});
