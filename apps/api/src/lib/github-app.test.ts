/**
 * Safety tests for the GitHub App.
 *
 * This module holds two credentials that are worth stealing — an RSA private key
 * that can mint a token for every installation, and the installation tokens
 * themselves — and it talks to the internet while holding them. So the cases
 * below are mostly not about check runs. They are about the four ways this file
 * could leak or misuse a credential, each of which this repo has already shipped
 * once in a neighbouring module:
 *
 *   • a host that came out of config instead of a constant
 *   • a path that escaped the repo it was supposed to name
 *   • a redirect followed while the Authorization header was set
 *   • a secret that reached a log line or an error message
 *
 * The rest assert the thing the feature exists for: that the check reports a
 * TRIAGE VERDICT rather than a pass/fail count, and that an annotation lands on
 * the line that actually failed — because a wrong line is read as fact.
 */

import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANNOTATIONS_PER_REQUEST,
  APP_KEY_VAULT_NAME,
  APP_KEY_VAULT_ORG,
  CHECK_NAME,
  GITHUB_API_HOST,
  GithubAppError,
  MAX_ANNOTATIONS,
  RERUN_ACTION,
  _resetTokenCache,
  annotationLine,
  annotationPath,
  appJwt,
  buildAnnotations,
  buildCheckOutput,
  chunkAnnotations,
  conclusionFor,
  createCheckRun,
  findCheckRun,
  installationToken,
  isRerunRequest,
  loadAppConfig,
  normalizePem,
  parseCheckRunEvent,
  parseInstallationEvent,
  summarizeTriage,
  updateCheckRun,
  webhookSignatureMatches,
  type AppConfig,
  type CheckEvidence,
  type CheckFailure,
  type FetchLike,
} from './github-app.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString().trim();

const cfg: AppConfig = { appId: '1234', privateKeyPem: PEM, webhookSecret: 'shh' };

const SHA = 'a'.repeat(40);

/** A fetch that records every call and answers from a script. */
function scriptedFetch(
  responses: Array<{ status: number; body?: unknown; type?: ResponseType }>,
): FetchLike & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)] ?? { status: 500 };
    return {
      status: next.status,
      type: next.type ?? 'default',
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    } as unknown as Response;
  }) as FetchLike & { calls: Array<{ url: string; init: RequestInit }> };
  impl.calls = calls;
  return impl;
}

function failure(over: Partial<CheckFailure> = {}): CheckFailure {
  return {
    test: { name: 'Checkout completes', filePath: 'tests/checkout.spec.ts', code: null },
    status: 'FAILED',
    errorMessage: 'expect(locator).toBeVisible() failed',
    step: null,
    verdict: null,
    fixProposed: false,
    ...over,
  };
}

function evidence(over: Partial<CheckEvidence> = {}): CheckEvidence {
  return {
    run: {
      id: 'run_1',
      status: 'FAILED',
      commitSha: SHA,
      prNumber: 7,
      passedCount: 9,
      failedCount: 1,
      flakyCount: 0,
      totalCount: 10,
      errorMessage: null,
      gateBlocking: false,
    },
    environment: { name: 'Preview', kind: 'PREVIEW' },
    failures: [failure()],
    webUrl: 'https://qaai.example.com',
    ...over,
  };
}

afterEach(() => _resetTokenCache());

// ─── Configuration degrades honestly ─────────────────────────────────────────

describe('loadAppConfig', () => {
  const unseal = () => PEM;

  it('returns null when nothing is configured, so the PAT path is untouched', () => {
    expect(loadAppConfig(unseal, {})).toBeNull();
  });

  it('refuses a half-configured app rather than silently doing nothing', () => {
    // A check that never appears reads to a reviewer exactly like a green build,
    // so the one thing this must not do is shrug.
    expect(() => loadAppConfig(unseal, { GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(/GITHUB_APP_ID/);
    expect(() => loadAppConfig(unseal, { GITHUB_APP_ID: '1' })).toThrow(/private key/);
    expect(() => loadAppConfig(unseal, { GITHUB_APP_ID: 'Iv1.abc', GITHUB_APP_PRIVATE_KEY: PEM })).toThrow(
      /numeric App ID/,
    );
  });

  it('prefers the vault, and unseals it under the deployment AAD', () => {
    const seen: string[] = [];
    const config = loadAppConfig(
      (ciphertext, keyVersion, orgId, name) => {
        seen.push(`${ciphertext}|${keyVersion}|${orgId}|${name}`);
        return PEM;
      },
      {
        GITHUB_APP_ID: '99',
        GITHUB_APP_PRIVATE_KEY_ENC: 'sealed',
        GITHUB_APP_KEY_VERSION: '2',
        GITHUB_APP_PRIVATE_KEY: 'ignored-because-the-vault-wins',
      },
    );
    expect(config?.privateKeyPem).toBe(PEM);
    expect(seen).toEqual([`sealed|2|${APP_KEY_VAULT_ORG}|${APP_KEY_VAULT_NAME}`]);
  });

  it('never echoes the vault error, which names the secret', () => {
    expect(() =>
      loadAppConfig(
        () => {
          throw new Error('Unable to decrypt secret "github-app:private-key" — wrong key');
        },
        { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_ENC: 'sealed' },
      ),
    ).toThrow(/could not be unsealed/);
  });

  it('accepts a PEM that survived a .env file, in either shape', () => {
    expect(normalizePem(PEM.replace(/\n/g, '\\n'))).toBe(PEM.trim());
    expect(normalizePem(Buffer.from(PEM).toString('base64'))).toBe(PEM.trim());
    expect(normalizePem('not a key')).toBe('');
  });
});

// ─── The app JWT ─────────────────────────────────────────────────────────────

describe('appJwt', () => {
  it('is an RS256 JWT GitHub will accept, signed by the app key', () => {
    const now = 1_800_000_000_000;
    const token = appJwt(cfg.appId, PEM, now);
    const [header, payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe('1234');
    // Backdated, because GitHub rejects a JWT whose iat is in its own future.
    expect(claims.iat).toBeLessThan(Math.floor(now / 1000));
    // And under GitHub's ten-minute ceiling, measured from the backdated iat.
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('turns an unusable key into a sentence, not an OpenSSL error', () => {
    expect(() => appJwt('1', '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----'))
      .toThrow(GithubAppError);
  });
});

// ─── Installation tokens ─────────────────────────────────────────────────────

describe('installationToken', () => {
  const minted = (token: string, expires: string) => ({
    status: 201,
    body: { token, expires_at: expires },
  });

  it('caches until shortly before expiry, then mints again', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const fetchImpl = scriptedFetch([
      minted('ghs_first', '2026-01-01T01:00:00Z'),
      minted('ghs_second', '2026-01-01T02:00:00Z'),
    ]);

    expect(await installationToken(cfg, '42', { fetchImpl, nowMs: now })).toBe('ghs_first');
    expect(await installationToken(cfg, '42', { fetchImpl, nowMs: now + 60_000 })).toBe('ghs_first');
    expect(fetchImpl.calls).toHaveLength(1);

    // 30s before expiry is inside the refresh margin: a token that expires in
    // flight fails a check run that had already passed.
    expect(
      await installationToken(cfg, '42', { fetchImpl, nowMs: now + 3_600_000 - 30_000 }),
    ).toBe('ghs_second');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('sends the JWT in a header, never in the URL', async () => {
    const fetchImpl = scriptedFetch([minted('ghs_x', '2026-01-01T01:00:00Z')]);
    await installationToken(cfg, '42', { fetchImpl });

    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe(`https://${GITHUB_API_HOST}/app/installations/42/access_tokens`);
    expect(call.url).not.toMatch(/eyJ/); // a JWT's base64url header always starts here
    expect(String((call.init.headers as Record<string, string>).authorization)).toMatch(/^Bearer /);
  });

  it('refuses an installation id that is not digits — it lands in a path', async () => {
    const fetchImpl = scriptedFetch([minted('ghs_x', '2026-01-01T01:00:00Z')]);
    await expect(installationToken(cfg, '../../repos/evil', { fetchImpl })).rejects.toThrow(
      /not a valid GitHub installation id/,
    );
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('will not follow a redirect while holding the app JWT', async () => {
    const fetchImpl = scriptedFetch([{ status: 302 }]);
    await expect(installationToken(cfg, '42', { fetchImpl })).rejects.toThrow(/redirect/);
  });

  it('names the fix when GitHub rejects the credential', async () => {
    const fetchImpl = scriptedFetch([{ status: 401 }]);
    await expect(installationToken(cfg, '42', { fetchImpl })).rejects.toThrow(/GITHUB_APP_ID/);
  });

  it('assumes the shortest safe lifetime when the expiry is unreadable', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const fetchImpl = scriptedFetch([
      { status: 201, body: { token: 'ghs_a', expires_at: 'whenever' } },
      { status: 201, body: { token: 'ghs_b', expires_at: '2026-01-01T02:00:00Z' } },
    ]);
    expect(await installationToken(cfg, '7', { fetchImpl, nowMs: now })).toBe('ghs_a');
    expect(await installationToken(cfg, '7', { fetchImpl, nowMs: now + 5 * 60_000 })).toBe('ghs_b');
  });
});

// ─── The host and the path ───────────────────────────────────────────────────

describe('host pinning', () => {
  it('will not let a repo string choose the host', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { id: 1 } }]);
    await expect(
      createCheckRun(
        'ghs_token',
        'https://evil.example.com/acme/store',
        { headSha: SHA, externalId: 'run_1', detailsUrl: 'https://x/y', status: 'in_progress' },
        { fetchImpl },
      ),
    ).rejects.toThrow(/may only file on github\.com/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('will not let a repo string climb out of its path', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { id: 1 } }]);
    await expect(
      createCheckRun(
        'ghs_token',
        '../../app/installations',
        { headSha: SHA, externalId: 'run_1', detailsUrl: 'https://x/y', status: 'in_progress' },
        { fetchImpl },
      ),
    ).rejects.toThrow(/owner\/repository/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('refuses a head sha that is not a sha', async () => {
    const fetchImpl = scriptedFetch([{ status: 200, body: { check_runs: [] } }]);
    await expect(
      findCheckRun('ghs_token', 'acme/store', '../../../secrets', 'run_1', { fetchImpl }),
    ).rejects.toThrow(/not a commit SHA/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('builds every check-run URL on the pinned host', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { id: 5, html_url: 'https://gh/c/5' } }]);
    const ref = await createCheckRun(
      'ghs_token',
      'acme/store',
      { headSha: SHA, externalId: 'run_1', detailsUrl: 'https://qaai/runs/run_1', status: 'in_progress' },
      { fetchImpl },
    );
    expect(ref).toEqual({ id: 5, url: 'https://gh/c/5' });
    expect(fetchImpl.calls[0]!.url).toBe(`https://${GITHUB_API_HOST}/repos/acme/store/check-runs`);
    expect(JSON.parse(fetchImpl.calls[0]!.init.body as string).name).toBe(CHECK_NAME);
  });

  it('will not follow a redirect while updating a check run', async () => {
    const fetchImpl = scriptedFetch([{ status: 0, type: 'opaqueredirect' }]);
    await expect(
      updateCheckRun('ghs_token', 'acme/store', 5, { status: 'completed' }, { fetchImpl }),
    ).rejects.toThrow(/redirect/);
  });
});

describe('findCheckRun', () => {
  it('matches on external_id, not on "the most recent check called QAAI"', async () => {
    const fetchImpl = scriptedFetch([
      {
        status: 200,
        body: {
          check_runs: [
            { id: 1, external_id: 'run_other', html_url: 'https://gh/1' },
            { id: 2, external_id: 'run_1', html_url: 'https://gh/2' },
          ],
        },
      },
    ]);
    expect(await findCheckRun('t', 'acme/store', SHA, 'run_1', { fetchImpl })).toEqual({
      id: 2,
      url: 'https://gh/2',
    });
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    // A miss costs a duplicate check at worst. A throw would cost the run its
    // report, which is the one outcome that is never acceptable.
    const fetchImpl = scriptedFetch([{ status: 500 }]);
    expect(await findCheckRun('t', 'acme/store', SHA, 'run_1', { fetchImpl })).toBeNull();
  });
});

// ─── Webhook signatures ──────────────────────────────────────────────────────

describe('webhookSignatureMatches', () => {
  const body = Buffer.from('{"action":"created"}');
  const sign = (secret: string) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts the signature GitHub sends', () => {
    expect(webhookSignatureMatches(body, sign('shh'), 'shh')).toBe(true);
  });

  it('rejects a forged one, a missing one, and a short one without throwing', () => {
    expect(webhookSignatureMatches(body, sign('other'), 'shh')).toBe(false);
    expect(webhookSignatureMatches(body, undefined, 'shh')).toBe(false);
    // timingSafeEqual throws on a length mismatch; the guard has to come first.
    expect(webhookSignatureMatches(body, 'sha256=short', 'shh')).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    expect(webhookSignatureMatches(body, sign(''), '')).toBe(false);
  });
});

// ─── Reading webhook payloads ────────────────────────────────────────────────

describe('parseInstallationEvent', () => {
  it('reads the repositories an installation can see', () => {
    expect(
      parseInstallationEvent({
        action: 'created',
        installation: { id: 42, account: { login: 'acme' } },
        repositories: [{ full_name: 'acme/store' }, { full_name: 'acme/api' }],
      }),
    ).toEqual({
      action: 'created',
      installationId: '42',
      account: 'acme',
      added: ['acme/store', 'acme/api'],
      removed: [],
      revokesAll: false,
    });
  });

  it('reads both deltas of installation_repositories', () => {
    const event = parseInstallationEvent({
      action: 'added',
      installation: { id: 42 },
      repositories_added: [{ full_name: 'acme/new' }],
      repositories_removed: [{ full_name: 'acme/old' }],
    });
    expect(event.added).toEqual(['acme/new']);
    expect(event.removed).toEqual(['acme/old']);
  });

  it('drops a repository name it would not be willing to query with', () => {
    const event = parseInstallationEvent({
      action: 'created',
      installation: { id: 42 },
      repositories: [{ full_name: '../../evil' }, { full_name: 'acme/ok' }],
    });
    expect(event.added).toEqual(['acme/ok']);
  });

  it('treats deletion and suspension as revoking everything', () => {
    for (const action of ['deleted', 'suspend']) {
      const event = parseInstallationEvent({
        action,
        installation: { id: 42 },
        repositories: [{ full_name: 'acme/store' }],
      });
      expect(event.revokesAll).toBe(true);
      // Nothing is "added" by a delete, however the payload is shaped.
      expect(event.added).toEqual([]);
    }
  });
});

describe('parseCheckRunEvent', () => {
  const payload = {
    action: 'requested_action',
    requested_action: { identifier: 'qaai-rerun' },
    repository: { full_name: 'acme/store' },
    installation: { id: 42 },
    check_run: { id: 9, external_id: 'run_1', head_sha: SHA, pull_requests: [{ number: 7 }] },
  };

  it('reads what the re-run button needs', () => {
    expect(parseCheckRunEvent(payload)).toEqual({
      action: 'requested_action',
      repoFullName: 'acme/store',
      headSha: SHA,
      externalId: 'run_1',
      checkRunId: 9,
      installationId: '42',
      requestedAction: 'qaai-rerun',
      prNumbers: [7],
    });
  });

  it('recognises both ways a reviewer asks for a re-run, and nothing else', () => {
    expect(isRerunRequest(parseCheckRunEvent(payload))).toBe(true);
    expect(isRerunRequest(parseCheckRunEvent({ ...payload, action: 'rerequested' }))).toBe(true);
    expect(isRerunRequest(parseCheckRunEvent({ ...payload, action: 'completed' }))).toBe(false);
    expect(
      isRerunRequest(
        parseCheckRunEvent({ ...payload, requested_action: { identifier: 'something-else' } }),
      ),
    ).toBe(false);
  });

  it('refuses a repository name that is not owner/name', () => {
    expect(
      parseCheckRunEvent({ ...payload, repository: { full_name: 'https://evil.com/a/b' } })
        .repoFullName,
    ).toBeNull();
  });
});

// ─── The re-run button ───────────────────────────────────────────────────────

describe('RERUN_ACTION', () => {
  it('stays inside GitHub’s limits, which are a 422 on the whole check run', () => {
    expect(RERUN_ACTION.label.length).toBeLessThanOrEqual(20);
    expect(RERUN_ACTION.description.length).toBeLessThanOrEqual(40);
    expect(RERUN_ACTION.identifier.length).toBeLessThanOrEqual(20);
  });

  it('is only attached when asked for', async () => {
    const fetchImpl = scriptedFetch([{ status: 201, body: { id: 1 } }]);
    await createCheckRun(
      't',
      'acme/store',
      {
        headSha: SHA,
        externalId: 'run_1',
        detailsUrl: 'https://x/y',
        status: 'completed',
        conclusion: 'failure',
        withRerunAction: true,
      },
      { fetchImpl },
    );
    expect(JSON.parse(fetchImpl.calls[0]!.init.body as string).actions).toEqual([RERUN_ACTION]);
  });
});

// ─── What the check actually says ────────────────────────────────────────────

describe('summarizeTriage', () => {
  it('reports the verdict, not the count — this is the whole feature', () => {
    const failures = [
      failure({ verdict: { verdict: 'REAL_BUG', confidence: 0.9, explanation: 'x' } }),
      failure({ verdict: { verdict: 'REAL_BUG', confidence: 0.8, explanation: 'x' } }),
      failure({
        verdict: { verdict: 'INTENDED_CHANGE', confidence: 0.7, explanation: 'x' },
        fixProposed: true,
      }),
    ];
    expect(summarizeTriage(failures)).toBe(
      '2 look like real bugs, 1 is an intended change with a fix proposed.',
    );
  });

  it('says "not triaged yet" rather than guessing a bucket', () => {
    expect(summarizeTriage([failure(), failure()])).toBe('2 are not triaged yet.');
  });

  it('only claims a fix when one exists', () => {
    expect(
      summarizeTriage([
        failure({ verdict: { verdict: 'INTENDED_CHANGE', confidence: 0.7, explanation: 'x' } }),
      ]),
    ).toBe('1 is an intended change.');
  });

  it('counts flakes and environment issues in their own words', () => {
    expect(
      summarizeTriage([
        failure({ verdict: { verdict: 'FLAKE', confidence: 0.7, explanation: 'x' } }),
        failure({ verdict: { verdict: 'ENV_ISSUE', confidence: 0.7, explanation: 'x' } }),
      ]),
    ).toBe('1 is flaky, 1 is an environment issue.');
  });
});

describe('conclusionFor', () => {
  it('is green only when nothing failed', () => {
    expect(conclusionFor(evidence({ failures: [] }))).toBe('success');
  });

  it('is red when the gate blocked, whatever triage thought', () => {
    const e = evidence({
      run: { ...evidence().run, gateBlocking: true },
      failures: [failure({ verdict: { verdict: 'FLAKE', confidence: 0.9, explanation: 'x' } })],
    });
    expect(conclusionFor(e)).toBe('failure');
  });

  it('is red for a real bug and for anything not yet triaged', () => {
    expect(conclusionFor(evidence())).toBe('failure');
    expect(
      conclusionFor(
        evidence({
          failures: [failure({ verdict: { verdict: 'REAL_BUG', confidence: 0.9, explanation: 'x' } })],
        }),
      ),
    ).toBe('failure');
  });

  it('is neutral — not green — when every failure is explained away', () => {
    // A flake is not a pass. Green here teaches people that green means nothing.
    const e = evidence({
      failures: [
        failure({ verdict: { verdict: 'FLAKE', confidence: 0.9, explanation: 'x' } }),
        failure({ verdict: { verdict: 'INTENDED_CHANGE', confidence: 0.9, explanation: 'x' } }),
      ],
    });
    expect(conclusionFor(e)).toBe('neutral');
  });

  it('does not blame the PR when QAAI itself fell over', () => {
    const e = evidence({ run: { ...evidence().run, status: 'ERRORED' }, failures: [] });
    expect(conclusionFor(e)).toBe('action_required');
    expect(conclusionFor(evidence({ run: { ...evidence().run, status: 'CANCELLED' } }))).toBe(
      'cancelled',
    );
  });
});

describe('buildCheckOutput', () => {
  it('puts the triage sentence in the title a reviewer sees first', () => {
    const out = buildCheckOutput(
      evidence({
        failures: [
          failure({ verdict: { verdict: 'REAL_BUG', confidence: 0.91, explanation: 'Button gone' } }),
        ],
      }),
    );
    expect(out.title).toBe('1 failed — 1 looks like a real bug.');
    expect(out.summary).toContain('9 passed');
    expect(out.summary).toContain('[Open the full run in QAAI](https://qaai.example.com/runs/run_1)');
    expect(out.text).toContain('Button gone');
  });

  it('says the run did not finish instead of reporting a verdict on the change', () => {
    const out = buildCheckOutput(
      evidence({
        run: { ...evidence().run, status: 'ERRORED', errorMessage: 'browser crashed' },
        failures: [],
      }),
    );
    expect(out.summary).toContain('The run did not finish');
    expect(out.summary).toContain('browser crashed');
  });

  it('stays inside GitHub’s field limits with a pathological run', () => {
    const many = Array.from({ length: 400 }, () =>
      failure({ errorMessage: 'e'.repeat(2_000), test: { name: 'n'.repeat(300), filePath: 'a/b.ts', code: null } }),
    );
    const out = buildCheckOutput(evidence({ failures: many }));
    expect(out.title.length).toBeLessThanOrEqual(255);
    expect(out.summary.length).toBeLessThanOrEqual(65_535);
    expect(out.text.length).toBeLessThanOrEqual(65_535);
  });

  it('does not let an error message break out of its code fence', () => {
    const out = buildCheckOutput(
      evidence({ failures: [failure({ errorMessage: '```\n### not a heading' })] }),
    );
    expect(out.text).not.toContain('\n```\n### not a heading');
  });
});

// ─── Annotations: the thing a comment cannot do ──────────────────────────────

describe('annotationLine', () => {
  const code = [
    "import { test, expect } from '@playwright/test';",
    '',
    "test('checkout', async ({ page }) => {",
    "  await page.goto('/cart');",
    "  await page.getByRole('button', { name: 'Pay' }).click();",
    '});',
  ].join('\n');

  it('uses the line the runner’s own stack named', () => {
    expect(
      annotationLine({
        code,
        filePath: 'tests/checkout.spec.ts',
        // The runner writes an absolute path into a workspace that is gone.
        errorText: 'at /tmp/.qaai-runs/abc/tests/checkout.spec.ts:5:41',
        selector: null,
        stepTitle: null,
      }),
    ).toBe(5);
  });

  it('falls back to the line holding the locator that failed', () => {
    expect(
      annotationLine({
        code,
        filePath: 'tests/checkout.spec.ts',
        errorText: 'expect(locator).toBeVisible() failed',
        selector: "getByRole('button', { name: 'Pay' })",
        stepTitle: null,
      }),
    ).toBe(5);
  });

  it('annotates the top of the file rather than guessing a plausible line', () => {
    expect(
      annotationLine({
        code,
        filePath: 'tests/checkout.spec.ts',
        errorText: 'Timeout of 30000ms exceeded',
        selector: null,
        stepTitle: null,
      }),
    ).toBe(1);
  });

  it('clamps a stack line past the end of the file', () => {
    // A stale trace against edited source would otherwise 422 the whole update.
    expect(
      annotationLine({
        code,
        filePath: 'tests/checkout.spec.ts',
        errorText: 'at tests/checkout.spec.ts:900:1',
        selector: null,
        stepTitle: null,
      }),
    ).toBe(6);
  });
});

describe('annotationPath', () => {
  it('normalises what GitHub will take and refuses what it will not', () => {
    expect(annotationPath('./tests/a.spec.ts')).toBe('tests/a.spec.ts');
    expect(annotationPath('/tests/a.spec.ts')).toBe('tests/a.spec.ts');
    expect(annotationPath('../outside.spec.ts')).toBeNull();
    expect(annotationPath('C:\\tests\\a.spec.ts')).toBeNull();
    expect(annotationPath('   ')).toBeNull();
  });
});

describe('buildAnnotations', () => {
  it('marks a real bug as a failure and an explained one as a warning', () => {
    const annotations = buildAnnotations(
      evidence({
        failures: [
          failure({ verdict: { verdict: 'REAL_BUG', confidence: 0.9, explanation: 'Gone' } }),
          failure({ verdict: { verdict: 'FLAKE', confidence: 0.9, explanation: 'Timing' } }),
          failure(),
        ],
      }),
    );
    expect(annotations.map((a) => a.annotation_level)).toEqual(['failure', 'warning', 'failure']);
    expect(annotations[0]!.message).toContain('QAAI triage');
  });

  it('carries the failing step so the annotation is actionable in place', () => {
    const [annotation] = buildAnnotations(
      evidence({
        failures: [
          failure({
            step: {
              index: 2,
              title: 'Click Pay',
              selector: '#pay',
              expected: 'visible',
              actual: 'hidden',
              errorMessage: null,
              errorStack: null,
            },
          }),
        ],
      }),
    );
    expect(annotation!.message).toContain('Failing step 3: Click Pay');
    expect(annotation!.message).toContain('Expected: visible');
  });

  it('drops an annotation it cannot place rather than sending a 422', () => {
    const annotations = buildAnnotations(
      evidence({
        failures: [failure({ test: { name: 'x', filePath: '../elsewhere.ts', code: null } })],
      }),
    );
    expect(annotations).toEqual([]);
  });

  it('redacts anything credential-shaped out of provider-bound text', () => {
    const [annotation] = buildAnnotations(
      evidence({
        failures: [failure({ errorMessage: 'auth failed for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' })],
      }),
    );
    expect(annotation!.message).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(annotation!.message).toContain('[redacted]');
  });

  it('is bounded, and chunked the way GitHub accepts it', () => {
    const annotations = buildAnnotations(
      evidence({ failures: Array.from({ length: 300 }, () => failure()) }),
    );
    expect(annotations).toHaveLength(MAX_ANNOTATIONS);

    const chunks = chunkAnnotations(annotations);
    expect(chunks).toHaveLength(MAX_ANNOTATIONS / ANNOTATIONS_PER_REQUEST);
    expect(chunks.every((c) => c.length <= ANNOTATIONS_PER_REQUEST)).toBe(true);
    expect(chunks.flat()).toHaveLength(annotations.length);
  });
});
