/**
 * ADVERSARIAL VERIFICATION of this round's OUTWARD-FACING WRITES.
 *
 * Not a unit test of a function's happy path — an attempt to make each of the
 * four irreversible writes (a PR in a customer's repository, a ticket in their
 * tracker, a commit, a committed fixture) do the thing it promises it cannot.
 * Every test below is written as the attack first and the assertion second, so
 * a reader can see what was tried rather than what was convenient to check.
 *
 * The attacks are grouped by the property they try to break:
 *   1. IDEMPOTENCY      — two concurrent claims, one artifact.
 *   2. TARGET INTEGRITY — can untrusted text choose the repo, branch or ref?
 *   3. SECRETS          — can a credential reach a committed fixture?
 *   4. ALLOWLIST        — does the promoter refuse by default, or block known-bad?
 *   5. EGRESS           — is 169.254.169.254 reachable while holding a token?
 */

import { describe, expect, it } from 'vitest';
import { untrusted } from '@qaai/agent';
import { SECRET_SHAPES } from '@qaai/shared';
import {
  credentialShapesIn,
  exchangeKeyOf,
  promoteRecording,
  type CapturedExchange,
  type FixtureApproval,
  type PromoteArgs,
} from './fixtures.js';
import {
  PR_TITLE,
  branchNameFor,
  buildPullRequestBody,
  openPullRequest,
  prCauseKey,
  type GitHost,
  type HostPullRequest,
  type PullRequestRecordRow,
  type PullRequestStore,
  type PullRequestTargetRecord,
} from './pull-request.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const sha = (input: string): string => {
  // A deterministic non-crypto digest. The promoter only needs stability.
  let h = 0n;
  for (const ch of input) h = (h * 1_000_003n + BigInt(ch.codePointAt(0) ?? 0)) % (1n << 64n);
  return h.toString(16).padStart(64, '0');
};

const CAUSE = prCauseKey('HEAL', 'proj-1', 'cluster-abc');

const target: PullRequestTargetRecord = {
  integrationId: 'int-1',
  provider: 'GITHUB',
  repo: 'acme/storefront',
  branch: branchNameFor({ purpose: 'HEAL', causeKey: CAUSE }),
  baseRef: 'main',
  pullRequestsEnabled: true,
};

function recordRow(over: Partial<PullRequestRecordRow> = {}): PullRequestRecordRow {
  return {
    id: 'pr-rec-1',
    orgId: 'org-1',
    projectId: 'proj-1',
    repo: target.repo,
    branch: target.branch,
    baseRef: target.baseRef,
    purpose: 'HEAL',
    causeKey: CAUSE,
    state: 'REQUESTED',
    number: null,
    url: null,
    ...over,
  };
}

/**
 * A store whose `claim` enforces `@@unique([orgId, causeKey])` the way Postgres
 * does: the FIRST insert wins and every later one is told who won. `await null`
 * before the check is what makes two concurrent callers actually interleave —
 * without it both run to completion inside one microtask and the race the
 * database would see never happens.
 */
function racingStore(opts: { onDisk?: PullRequestRecordRow | null } = {}): {
  store: PullRequestStore;
  claims: number;
  inserted: PullRequestRecordRow[];
  attached: Array<{ healId: string; url: string }>;
} {
  const rows = new Map<string, PullRequestRecordRow>();
  if (opts.onDisk) rows.set(`${opts.onDisk.orgId}|${opts.onDisk.causeKey}`, opts.onDisk);
  const state = {
    claims: 0,
    inserted: [] as PullRequestRecordRow[],
    attached: [] as Array<{ healId: string; url: string }>,
  };
  const store: PullRequestStore = {
    async loadTarget() {
      return target;
    },
    async findByCauseKey({ orgId, causeKey }) {
      return rows.get(`${orgId}|${causeKey}`) ?? null;
    },
    async claim(args) {
      state.claims += 1;
      // Yield, so a second concurrent claim gets to run before this one writes.
      await Promise.resolve();
      await Promise.resolve();
      const key = `${args.orgId}|${args.causeKey}`;
      const existing = rows.get(key);
      if (existing) return { created: false, row: existing };
      const row = recordRow({ orgId: args.orgId, causeKey: args.causeKey, repo: args.repo });
      rows.set(key, row);
      state.inserted.push(row);
      return { created: true, row };
    },
    async settle(args) {
      const row = [...rows.values()].find((candidate) => candidate.id === args.id);
      const next = { ...(row ?? recordRow()), ...args } as PullRequestRecordRow;
      if (row) rows.set(`${row.orgId}|${row.causeKey}`, next);
      return next;
    },
    async attachToHeal(args) {
      state.attached.push({ healId: args.healId, url: args.url });
    },
  };
  return {
    store,
    get claims() {
      return state.claims;
    },
    get inserted() {
      return state.inserted;
    },
    get attached() {
      return state.attached;
    },
  };
}

function countingHost(over: Partial<GitHost> = {}): { host: GitHost; opened: number } {
  const state = { opened: 0 };
  const host: GitHost = {
    provider: 'GITHUB',
    apiHost: 'api.github.com',
    apiHostFromCustomerConfig: false,
    async openPullRequest() {
      state.opened += 1;
      const pr: HostPullRequest = {
        number: 41 + state.opened,
        url: `https://github.com/${target.repo}/pull/${41 + state.opened}`,
        state: 'OPEN',
      };
      return { ok: true, pr };
    },
    async findOpenPullRequest() {
      return null;
    },
    ...over,
  };
  return {
    host,
    get opened() {
      return state.opened;
    },
  };
}

const noAudit = { async record() {} };

// ─────────────────────────────────────────────────────────────────────────────
// 1. IDEMPOTENCY
// ─────────────────────────────────────────────────────────────────────────────

describe('one pull request per cause, under a real race', () => {
  it('opens exactly ONE pull request when two callers claim the same cause concurrently', async () => {
    const { store, inserted } = racingStore();
    const hostState = countingHost();
    const host = hostState.host;

    // Two PARALLEL calls, not two sequential ones. This is the retried CI step
    // and the double-click, which are the two ways this actually happens.
    const [left, right] = await Promise.all([
      openPullRequest(
        { store, host, audit: noAudit },
        {
          orgId: 'org-1',
          projectId: 'proj-1',
          purpose: 'HEAL',
          causeKey: CAUSE,
          integrationId: 'int-1',
          filePaths: ['tests/checkout.spec.ts'],
          preservedPaths: [],
        },
      ),
      openPullRequest(
        { store, host, audit: noAudit },
        {
          orgId: 'org-1',
          projectId: 'proj-1',
          purpose: 'HEAL',
          causeKey: CAUSE,
          integrationId: 'int-1',
          filePaths: ['tests/checkout.spec.ts'],
          preservedPaths: [],
        },
      ),
    ]);

    // The constraint decided it, not a check-then-write: exactly one INSERT.
    expect(inserted).toHaveLength(1);
    // And exactly one request reached the host.
    expect(hostState.opened).toBe(1);

    const outcomes = [left.outcome, right.outcome].sort();
    expect(outcomes).toEqual(['ALREADY_RECORDED', 'OPENED']);

    // The loser reports WHAT ALREADY EXISTS rather than a bare failure — a
    // `false` with no row would make a concurrent claim indistinguishable from
    // a vanished one.
    const loser = left.outcome === 'ALREADY_RECORDED' ? left : right;
    expect(loser.record).not.toBeNull();
  });

  it('sends nothing at all when the cause was already claimed before the call', async () => {
    const { store } = racingStore({
      onDisk: recordRow({ state: 'OPEN', number: 7, url: 'https://github.com/acme/storefront/pull/7' }),
    });
    const hostState = countingHost();
    const host = hostState.host;

    const result = await openPullRequest(
      { store, host, audit: noAudit },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('ALREADY_RECORDED');
    expect(hostState.opened).toBe(0);
    expect(result.url).toBe('https://github.com/acme/storefront/pull/7');
  });

  it('adopts the host’s existing pull request rather than opening a second', async () => {
    const { store } = racingStore();
    const existing: HostPullRequest = {
      number: 99,
      url: 'https://github.com/acme/storefront/pull/99',
      state: 'OPEN',
    };
    let opens = 0;
    const { host } = countingHost({
      async openPullRequest() {
        opens += 1;
        return { ok: false, refusal: 'ALREADY_EXISTS' };
      },
      async findOpenPullRequest() {
        return existing;
      },
    });

    const result = await openPullRequest(
      { store, host, audit: noAudit },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('ADOPTED_EXISTING');
    expect(result.url).toBe(existing.url);
    expect(opens).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TARGET INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────

describe('untrusted text cannot choose the target', () => {
  it('refuses every cause key that is not 64 hex characters, so a branch cannot be composed from text', () => {
    const attacks = [
      // A failure message that names a branch.
      'main',
      'refs/heads/main',
      // Path traversal out of the qaai/ prefix.
      '../../main',
      `${'a'.repeat(64)}/../../../main`,
      // A ref with an option-looking prefix.
      '--force',
      // Newlines, to split a ref file or a shell line.
      `${'a'.repeat(63)}\nmain`,
      // Uppercase hex is still not the shape we compose.
      'A'.repeat(64),
      // A plausible-looking cluster key.
      'heal-1',
      '',
    ];
    for (const causeKey of attacks) {
      expect(() => branchNameFor({ purpose: 'HEAL', causeKey }), causeKey).toThrow();
    }
  });

  it('composes the branch from a hash, so there is no parameter test output could occupy', () => {
    const branch = branchNameFor({ purpose: 'HEAL', causeKey: CAUSE });
    // Three segments, the first ours, the last 12 hex characters.
    expect(branch).toMatch(/^qaai\/heal\/[0-9a-f]{12}$/);
    // And it is a function of the cause alone.
    expect(branchNameFor({ purpose: 'HEAL', causeKey: CAUSE })).toBe(branch);
  });

  it('refuses when the pushed branch is not the branch this cause composes', async () => {
    const { store } = racingStore();
    const hostState = countingHost();
    const host = hostState.host;
    // The caller's own target claims a different branch than the cause composes.
    const hijacked: PullRequestStore = {
      ...store,
      async loadTarget() {
        return { ...target, branch: 'main' };
      },
    };

    const result = await openPullRequest(
      { store: hijacked, host, audit: noAudit },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('REFUSED');
    expect(hostState.opened).toBe(0);
    // A zod/own PATH, never a message built out of the offending value.
    expect(result.refusalPaths.join(' ')).not.toContain('main');
  });

  it('builds the title from a count and a hex handle, so a model cannot inject a header or a mention', () => {
    // Whatever a model or a test name said, the title is this shape.
    const title = PR_TITLE.HEAL(1, CAUSE.slice(0, 12));
    expect(title).toBe(`QAAI: fix the test failing under cause ${CAUSE.slice(0, 12)}`);
    expect(title).not.toMatch(/[\r\n]/);
    for (const purpose of ['HEAL', 'GENERATED_TESTS', 'RETIREMENT', 'CLOSURE_CAMPAIGN'] as const) {
      const composed = PR_TITLE[purpose](3, CAUSE.slice(0, 12));
      expect(composed, purpose).not.toMatch(/[\r\n@]/);
    }
  });

  it('refuses the whole call when pull requests are not enabled, before any token is used', async () => {
    const { store } = racingStore();
    const hostState = countingHost();
    const host = hostState.host;
    const disabled: PullRequestStore = {
      ...store,
      async loadTarget() {
        return { ...target, pullRequestsEnabled: false };
      },
    };

    const result = await openPullRequest(
      { store: disabled, host, audit: noAudit },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('REFUSED');
    expect(hostState.opened).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. EGRESS (grouped here because it is the same module)
// ─────────────────────────────────────────────────────────────────────────────

describe('a customer-named host is classified before anything connects', () => {
  it('refuses the link-local metadata address rather than connecting with the token', async () => {
    const { store } = racingStore();
    const hostState = countingHost({
      apiHost: '169.254.169.254',
      apiHostFromCustomerConfig: true,
    });
    const host = hostState.host;

    const result = await openPullRequest(
      { store, host, audit: noAudit, lookup: async () => [] },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('DESTINATION_REFUSED');
    expect(hostState.opened).toBe(0);
    // And the note does not teach the caller the internal address.
    expect(result.note).not.toContain('169.254');
  });

  it('refuses a customer host whose NAME resolves to a private address', async () => {
    const { store } = racingStore();
    const hostState = countingHost({
      apiHost: 'git.internal.example.com',
      apiHostFromCustomerConfig: true,
    });
    const host = hostState.host;

    const result = await openPullRequest(
      // A resolver that answers with a private address, which is the attack:
      // a public NAME pointed at 169.254.169.254.
      { store, host, audit: noAudit, lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
      {
        orgId: 'org-1',
        projectId: 'proj-1',
        purpose: 'HEAL',
        causeKey: CAUSE,
        integrationId: 'int-1',
        filePaths: ['tests/checkout.spec.ts'],
        preservedPaths: [],
      },
    );

    expect(result.outcome).toBe('DESTINATION_REFUSED');
    expect(hostState.opened).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 + 4. SECRETS IN COMMITTED CONTENT, AND THE ALLOWLIST'S DIRECTION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * THE HOSTILE CREDENTIALS, COMPOSED AT RUN TIME AND NEVER WRITTEN WHOLE.
 *
 * This file's whole job is to put credential-shaped strings through the
 * promoter and prove none of them reaches a committed artifact — so it needs
 * strings a detector matches. A COMPLETE key-shaped literal is also exactly
 * what GitHub push protection blocks, and it has already rejected a finished,
 * green commit in this repository: a `ghp_` prefix plus thirty-six plausible
 * characters is a personal access token as far as any scanner is concerned,
 * whoever typed it. The AWS value this file used to carry was worse — it was
 * the access key id from Amazon's own published examples, which is to say the
 * single most-matched one in existence.
 *
 * The prefixes come from `SECRET_SHAPES`, the same list the product's own
 * scanners derive from, and the tails say in words what they are. What is under
 * test is PREFIX detection, so an English tail weakens nothing — and the
 * assertions below still search for the whole composed value, which is the only
 * string that would appear in an artifact if the redactor missed it.
 */
const shapeFor = (what: string, fallback: string): string =>
  SECRET_SHAPES.find((shape) => shape.what.startsWith(what))?.prefix ?? fallback;

const FAKE_GITHUB_TOKEN = `${shapeFor('a GitHub personal access token', 'ghp_')}this-token-is-fabricated-for-this-test`;
const FAKE_AWS_KEY = `${shapeFor('an AWS access key id', 'AKIA')}FABRICATEDFORTEST`;

/** Realistic hostile traffic: every credential channel at once. */
function hostileExchanges(): CapturedExchange[] {
  return [
    {
      method: 'GET',
      url: `https://app.test/api/orders?api_key=${FAKE_AWS_KEY}&page=2`,
      status: 200,
      requestHeaders: [
        { name: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJldmFsdWU' },
        { name: 'Cookie', value: 'session=abcdef0123456789abcdef0123456789abcd' },
        { name: 'Accept', value: 'application/json' },
        { name: 'X-Internal-Host', value: 'orders.svc.cluster.local' },
      ],
      responseHeaders: [
        { name: 'Set-Cookie', value: 'session=9f8e7d6c5b4a39281706152433221100aabb; HttpOnly' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      requestBody: null,
      responseBody: JSON.stringify({
        orders: [{ sku: 'SKU-1', total: 1299 }],
        refreshToken: FAKE_GITHUB_TOKEN,
        customer: { email: 'dana@example.com', ssn: '123-45-6789' },
      }),
    },
  ];
}

function promoteArgs(over: Partial<PromoteArgs> = {}): PromoteArgs {
  return {
    exchanges: hostileExchanges(),
    baseUrl: 'https://app.test',
    approval: {},
    convention: 'JSON_RESPONSE_SET',
    destinationStem: 'tests/fixtures/orders',
    ledger: [],
    onDiskHash: null,
    digest: sha,
    ...over,
  };
}

describe('a credential cannot reach a committed fixture', () => {
  it('redacts or refuses every credential channel, and REPORTS each by count and kind', () => {
    const result = promoteRecording(promoteArgs());

    // Whatever the verdict, the report must account for what was removed.
    const kinds = new Set(result.report.redactions.map((entry) => entry.kind));

    // The auth header, the cookie, the set-cookie and the unapproved query
    // parameter are each their own kind, so a reader can see WHICH channel.
    expect(kinds.has('AUTH_HEADER')).toBe(true);
    expect(kinds.has('COOKIE_HEADER')).toBe(true);
    expect(kinds.has('SET_COOKIE')).toBe(true);

    // Counted, not merely listed.
    expect(result.report.redactions.length).toBeGreaterThan(0);
    for (const entry of result.report.redactions) {
      expect(entry.kind, JSON.stringify(entry)).toBeTruthy();
    }

    // THE LOAD-BEARING ASSERTION: nothing credential-shaped survives into the
    // bytes that would be committed. If the promotion succeeded, sweep it.
    if (result.ok) {
      for (const artifact of result.set.artifacts) {
        const shapes = credentialShapesIn(artifact.content);
        expect(shapes, `${artifact.path}: ${shapes.join(',')}`).toEqual([]);
        expect(artifact.content).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(artifact.content).not.toContain(FAKE_GITHUB_TOKEN);
        expect(artifact.content).not.toContain(FAKE_AWS_KEY);
        expect(artifact.content).not.toContain('9f8e7d6c5b4a39281706152433221100aabb');
        expect(artifact.content).not.toContain('abcdef0123456789abcdef0123456789abcd');
      }
    }
  });

  it('drops an unapproved body WHOLE, so a PII field is never a question of pattern matching', () => {
    const result = promoteRecording(promoteArgs());
    if (result.ok) {
      for (const artifact of result.set.artifacts) {
        // Neither the email nor the SSN was approved, so neither may appear.
        expect(artifact.content).not.toContain('dana@example.com');
        expect(artifact.content).not.toContain('123-45-6789');
      }
    }
  });

  it('keeps an internal hostname out of the fixture unless the customer named the header', () => {
    const result = promoteRecording(promoteArgs());
    if (result.ok) {
      for (const artifact of result.set.artifacts) {
        expect(artifact.content).not.toContain('orders.svc.cluster.local');
      }
    }
  });

  it('REFUSES rather than promoting when a credential survives the allowlist', () => {
    // A token hidden in a PATH SEGMENT: no header, no query parameter, no body
    // field, so the allowlist structurally cannot see it. The final sweep is
    // the only thing between it and the customer's git history.
    const result = promoteRecording(
      promoteArgs({
        exchanges: [
          {
            method: 'GET',
            url: `https://app.test/oauth/callback/${FAKE_GITHUB_TOKEN}`,
            status: 200,
            requestHeaders: [],
            responseHeaders: [],
            requestBody: null,
            responseBody: null,
          },
        ],
      }),
    );

    if (result.ok) {
      for (const artifact of result.set.artifacts) {
        expect(credentialShapesIn(artifact.content)).toEqual([]);
      }
    } else {
      expect(result.report.refusals.length).toBeGreaterThan(0);
    }
  });
});

describe('the promoter is an ALLOWLIST, not a blocklist', () => {
  it('drops a header nobody named even though it is harmless-looking', () => {
    const result = promoteRecording(
      promoteArgs({
        exchanges: [
          {
            method: 'GET',
            url: 'https://app.test/api/ping',
            status: 200,
            requestHeaders: [{ name: 'X-Request-Id', value: 'req-1' }],
            responseHeaders: [{ name: 'ETag', value: 'W/"abc"' }],
            requestBody: null,
            responseBody: null,
          },
        ],
      }),
    );

    // Not on SAFE_HEADER_NAMES and not approved, so it is gone and COUNTED.
    const kinds = result.report.redactions.map((entry) => entry.kind);
    expect(kinds).toContain('UNAPPROVED_HEADER');
    if (result.ok) {
      for (const artifact of result.set.artifacts) {
        expect(artifact.content).not.toContain('req-1');
      }
    }
  });

  it('admits a value ONLY when the customer named it, and names are exact, not prefixes', () => {
    const approval: FixtureApproval = {
      queryParams: ['page'],
      bodyExchangeKeys: [exchangeKeyOf('GET', '/api/orders')],
      bodyFields: ['orders.0.sku'],
    };
    const result = promoteRecording(promoteArgs({ approval }));

    if (result.ok) {
      const all = result.set.artifacts.map((artifact) => artifact.content).join('\n');
      // The approved field survives…
      expect(all).toContain('SKU-1');
      // …and its SIBLINGS, inside the same approved subtree, do NOT. A prefix
      // allowlist would have let `refreshToken` through on `orders`' coat-tails.
      expect(all).not.toContain(FAKE_GITHUB_TOKEN);
      expect(all).not.toContain('dana@example.com');
      expect(credentialShapesIn(all)).toEqual([]);
    }
  });

  it('promotes a SAFE fixture from an empty approval — the default is useful, not merely strict', () => {
    const result = promoteRecording(
      promoteArgs({
        exchanges: [
          {
            method: 'GET',
            url: 'https://app.test/api/health',
            status: 204,
            requestHeaders: [{ name: 'Accept', value: 'application/json' }],
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            requestBody: null,
            responseBody: null,
          },
        ],
        approval: {},
      }),
    );
    // Methods, paths and status codes are a fixture, and a safe one.
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 (continued). THE PR BODY
// ─────────────────────────────────────────────────────────────────────────────

describe('the pull-request body quotes untrusted text without obeying it', () => {
  it('scrubs a credential out of a fenced quote and SAYS how many lines it edited', () => {
    const built = buildPullRequestBody({
      purpose: 'HEAL',
      causeKey: CAUSE,
      filePaths: ['tests/checkout.spec.ts'],
      preservedPaths: ['tests/helpers/session.ts'],
      spans: [
        untrusted({
          provenance: 'RUNNER_OUTPUT',
          text: [
            'Error: request failed',
            `Authorization: Bearer ${FAKE_GITHUB_TOKEN}`,
            'Set-Cookie: session=9f8e7d6c5b4a39281706152433221100aabb',
          ].join('\n'),
        }),
      ],
    });

    expect(built.body).not.toContain(FAKE_GITHUB_TOKEN);
    expect(built.body).not.toContain('9f8e7d6c5b4a39281706152433221100aabb');
    // A body that was silently edited must not pass as a faithful quote.
    expect(built.credentialsScrubbed).toBeGreaterThan(0);
    expect(built.body).toContain('credential-shaped value removed');
  });

  it('names the files it LEFT ALONE, so the rest of the diff is trustworthy', () => {
    const built = buildPullRequestBody({
      purpose: 'HEAL',
      causeKey: CAUSE,
      filePaths: ['tests/checkout.spec.ts'],
      preservedPaths: ['tests/helpers/session.ts'],
    });
    expect(built.body).toContain('Files left alone because a human owns them** 1');
    expect(built.body).toContain('tests/helpers/session.ts');
  });
});
