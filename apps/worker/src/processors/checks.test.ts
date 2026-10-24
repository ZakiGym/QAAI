/**
 * Safety tests for the pull-request comment.
 *
 * The check run itself is covered by apps/api/src/lib/github-app.test.ts, which
 * owns the wording, the conclusion and the annotations. What is tested here is
 * the part that lives in this file and can only fail here — the behaviour that
 * decides whether this bot is one a team reads or one they mute:
 *
 *   • ONE comment per pull request, edited. A second push that POSTs instead of
 *     PATCHing is the bug; it looks fine in review, and shows up as ten comments
 *     on a busy PR.
 *   • Silence when there is nothing to say. A green run that has never had to
 *     complain must not introduce itself.
 *   • The comment never costs the check. A missing permission, a comment
 *     somebody deleted, a closed pull request and a rate limit each have a
 *     different right answer, and "log it and drop the report" is none of them.
 *   • The run is read inside its org. The job carries an orgId; a run that does
 *     not match it must produce no GitHub traffic at all.
 *
 * The GitHub half is a scripted `fetch` that keeps state — comments created by
 * one call are visible to the next — so "it edited rather than posted" is
 * asserted against the requests that actually went out, not against a flag the
 * code under test set for itself.
 */

import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetTokenCache, type CheckEvidence } from '../../../api/src/lib/github-app.js';

// ─── The world this processor runs in ────────────────────────────────────────

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()
  .trim();

process.env.GITHUB_APP_ID = '1234';
process.env.GITHUB_APP_PRIVATE_KEY = PEM;
process.env.WEB_PUBLIC_URL = 'https://qaai.example.com';

const h = vi.hoisted((): { prisma: Record<string, unknown>; redis: Map<string, string> } => ({
  prisma: {},
  redis: new Map(),
}));

// The worker's context opens Postgres and Redis at import time, so it is
// replaced wholesale; `h.prisma` is swapped per test through the proxy.
vi.mock('../context.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  connection: {
    get: async (key: string) => h.redis.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.redis.set(key, value);
      return 'OK';
    },
  },
}));

vi.mock('../vault.js', () => ({ open: () => PEM }));

// The queue is a producer only; nothing here asserts on it beyond it not
// exploding at import time.
vi.mock('bullmq', () => ({
  Queue: class {
    async add(): Promise<void> {}
  },
}));

const { PR_COMMENT_MARKER, buildPrComment, processChecks, worthCommenting, _resetCommentRefusals } =
  await import('./checks.js');

// ─── The GitHub end ──────────────────────────────────────────────────────────

const ORG = 'org_1';
const RUN = 'run_1';
const SHA = 'a'.repeat(40);
const REPO = 'acme/store';
const PR = 7;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const gh = {
  calls: [] as Call[],
  comments: [] as Array<{ id: number; body: string }>,
  nextCommentId: 500,
  /** Per-endpoint overrides, so one test can make one call fail. */
  listStatus: 200,
  createStatus: 201,
  patchStatus: 200,
  /** GitHub answers a secondary rate limit with 403 and these headers. */
  rateLimitHeaders: false,
};

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
}

function installFetch(): void {
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const method = String(init.method ?? 'GET');
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    gh.calls.push({ method, path, body });

    if (path.endsWith('/access_tokens')) {
      return reply(201, { token: 'ghs_secret', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (path.includes('/check-runs')) {
      return reply(method === 'POST' ? 201 : 200, { id: 999, html_url: 'https://github.com/c/1' });
    }

    // Issue comments.
    if (path.includes(`/issues/${PR}/comments`) && method === 'GET') {
      if (gh.listStatus !== 200) return reply(gh.listStatus, { message: 'nope' });
      return reply(200, gh.comments);
    }
    if (path.includes(`/issues/${PR}/comments`) && method === 'POST') {
      if (gh.createStatus !== 201) {
        return reply(
          gh.createStatus,
          { message: 'Resource not accessible by integration' },
          gh.rateLimitHeaders ? { 'x-ratelimit-remaining': '0' } : {},
        );
      }
      const created = { id: (gh.nextCommentId += 1), body: String(body?.body ?? '') };
      gh.comments.push(created);
      return reply(201, created);
    }
    if (path.includes('/issues/comments/') && method === 'PATCH') {
      if (gh.patchStatus !== 200) return reply(gh.patchStatus, { message: 'gone' });
      const id = Number(path.split('/').pop());
      const found = gh.comments.find((c) => c.id === id);
      if (found) found.body = String(body?.body ?? '');
      return reply(200, found ?? { id });
    }

    return reply(500, { message: 'unrouted' });
  }) as typeof fetch;
}

// ─── The run this processor reads ────────────────────────────────────────────

/** The two quarantine columns, as the database holds them for one test. */
interface QuarantineColumns {
  quarantined: boolean;
  /** Null means "never expires" — a quarantine written before expiry existed. */
  quarantineExpiresAt: Date | null;
}

const NOT_QUARANTINED: QuarantineColumns = { quarantined: false, quarantineExpiresAt: null };

interface RunOver {
  status?: string;
  passedCount?: number;
  failedCount?: number;
  /**
   * `Run.quarantinedFailedCount` — the FOURTH counter, not a slice of
   * `failedCount`. Defaulted to 0 rather than left absent, because absent is
   * what an older worker's run looks like and `suppressedFailuresIn` has a
   * separate fallback for that; a fixture that never sets it would test the
   * fallback forever and never the column.
   */
  quarantinedFailedCount?: number;
  gateResult?: unknown;
  prNumber?: number | null;
  failures?: number;
  /** Per failing test, index-aligned with the generated failures. */
  quarantine?: QuarantineColumns[];
}

function runRow(over: RunOver = {}) {
  const failures = over.failures ?? 1;
  return {
    id: RUN,
    status: over.status ?? 'FAILED',
    commitSha: SHA,
    prNumber: over.prNumber === undefined ? PR : over.prNumber,
    passedCount: over.passedCount ?? 9,
    failedCount: over.failedCount ?? failures,
    flakyCount: 0,
    quarantinedFailedCount: over.quarantinedFailedCount ?? 0,
    totalCount: 10,
    errorMessage: null,
    gateResult: over.gateResult ?? null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    project: { id: 'proj_1', repoFullName: REPO, repoInstallationId: '42' },
    environment: { name: 'Preview', kind: 'PREVIEW' },
    results: Array.from({ length: failures }, (_, i) => ({
      status: 'FAILED',
      errorMessage: 'expect(locator).toBeVisible() failed',
      test: {
        id: `test_${i}`,
        name: `Checkout completes ${i}`,
        filePath: `tests/checkout-${i}.spec.ts`,
        code: null,
        ...(over.quarantine?.[i] ?? NOT_QUARANTINED),
      },
      verdict: null,
      steps: [],
    })),
  };
}

/** Records what the processor asked the database for, so scoping is assertable. */
const runFindFirstArgs: Array<{ where: { id: string; orgId: string } }> = [];

/**
 * Project a fixture row through the `select` the processor actually asked for,
 * recursively, the way Prisma does.
 *
 * This is not tidiness. The fake used to hand back the whole fixture whatever
 * the query said, and a fake that shrugs at a missing `select` cannot fail the
 * test that proves the `select` is there — which is exactly how the original
 * defect survived: `quarantinedFailedCount` and the test's two quarantine
 * columns were simply never read, every consumer silently fell back to
 * inference, and nothing anywhere went red. Deleting a field from `loadRun`
 * now makes it `undefined` here, as it would in production.
 *
 * The nested `where`/`orderBy`/`take` are deliberately NOT applied: `runRow`
 * supplies exactly the rows those filters would select, so applying them would
 * only be a second implementation of the fixture.
 */
type Select = Record<string, unknown>;

function applySelect(value: unknown, select: Select | undefined): unknown {
  if (!select || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => applySelect(entry, select));

  const out: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(select)) {
    const held = (value as Record<string, unknown>)[key];
    if (want === true) out[key] = held;
    else if (want && typeof want === 'object') {
      out[key] = applySelect(held, (want as { select?: Select }).select);
    }
  }
  return out;
}

function usePrisma(row: ReturnType<typeof runRow> | null): void {
  h.prisma = {
    run: {
      findFirst: async (args: { where: { id: string; orgId: string }; select?: Select }) => {
        runFindFirstArgs.push(args);
        if (!row) return null;
        if (args.where.id !== row.id || args.where.orgId !== ORG) return null;
        return applySelect(row, args.select);
      },
    },
    healProposal: { findMany: async () => [] },
  };
}

const complete = () => processChecks({ orgId: ORG, runId: RUN, phase: 'completed' });

const commentCalls = () =>
  gh.calls.filter((c) => c.path.includes('/comments') && c.method !== 'GET');

beforeEach(() => {
  gh.calls = [];
  gh.comments = [];
  gh.nextCommentId = 500;
  gh.listStatus = 200;
  gh.createStatus = 201;
  gh.patchStatus = 200;
  gh.rateLimitHeaders = false;
  h.redis.clear();
  runFindFirstArgs.length = 0;
  _resetTokenCache();
  _resetCommentRefusals();
  installFetch();
  usePrisma(runRow());
});

// ─── One comment, forever ────────────────────────────────────────────────────

describe('one comment per pull request', () => {
  it('posts once and EDITS on the next run, rather than adding a second', async () => {
    await complete();
    expect(commentCalls().map((c) => c.method)).toEqual(['POST']);
    expect(gh.comments).toHaveLength(1);

    // The next push: a different result, same pull request. This is the whole
    // feature — a bot that POSTs here is the reason people mute bots.
    gh.calls = [];
    usePrisma(runRow({ failures: 2, failedCount: 2 }));
    await complete();

    expect(commentCalls().map((c) => c.method)).toEqual(['PATCH']);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain('Checkout completes 1');
  });

  it('finds its own comment by the marker when the cache is gone', async () => {
    await complete();
    const id = gh.comments[0]!.id;

    // A worker restart, an evicted key: the id is no longer known and the only
    // way back to the comment is the marker in its body. The result changes too,
    // so an edit is genuinely due — otherwise this would pass on the
    // "identical body, write nothing" path and prove nothing about the scan.
    h.redis.clear();
    gh.calls = [];
    usePrisma(runRow({ failures: 2, failedCount: 2 }));
    await complete();

    expect(commentCalls().map((c) => c.method)).toEqual(['PATCH']);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.id).toBe(id);
  });

  it('never adopts a comment that is not ours', async () => {
    // A human quoting QAAI in the thread. Editing somebody's comment because it
    // looked like ours is unforgivable, so the match is the hidden marker and
    // nothing else.
    gh.comments.push({ id: 1, body: '### ❌ QAAI — 1 failed. Is this real?' });
    await complete();

    expect(commentCalls().map((c) => c.method)).toEqual(['POST']);
    expect(gh.comments[0]!.body).toBe('### ❌ QAAI — 1 failed. Is this real?');
  });

  it('says nothing twice about the same run', async () => {
    await complete();
    gh.calls = [];
    // A re-post from POST /github/checks/:runId, or the sweep catching a run the
    // run processor already reported. The body is identical, so the edit is
    // pointless traffic.
    await complete();
    expect(commentCalls()).toHaveLength(0);
  });
});

// ─── Silence is a feature ────────────────────────────────────────────────────

describe('nothing to say', () => {
  it('does not introduce itself on a pull request that has always been green', async () => {
    usePrisma(runRow({ status: 'PASSED', failures: 0, failedCount: 0, passedCount: 10 }));
    await complete();
    expect(commentCalls()).toHaveLength(0);
  });

  it('but does correct a red comment that a green run has made stale', async () => {
    await complete();
    expect(gh.comments[0]!.body).toContain('❌');

    gh.calls = [];
    usePrisma(runRow({ status: 'PASSED', failures: 0, failedCount: 0, passedCount: 10 }));
    await complete();

    expect(commentCalls().map((c) => c.method)).toEqual(['PATCH']);
    expect(gh.comments[0]!.body).toContain('✅');
  });

  it('comments on a blocked gate even when no test failed', () => {
    // The gate is the rule the org wrote down; it blocking is news whatever the
    // test counts say.
    expect(worthCommenting(evidence({ failures: [], run: { ...base.run, gateBlocking: true } }))).toBe(true);
    expect(worthCommenting(evidence({ failures: [], run: { ...base.run, status: 'ERRORED' } }))).toBe(true);
    expect(worthCommenting(evidence({ failures: [] }))).toBe(false);
  });

  it('has no timeline to write in when the run is not a pull request', async () => {
    usePrisma(runRow({ prNumber: null }));
    await complete();
    expect(gh.calls.some((c) => c.path.includes('/comments'))).toBe(false);
  });
});

// ─── The comment never costs the check ───────────────────────────────────────

describe('GitHub says no', () => {
  const checkCompleted = () =>
    gh.calls.some(
      (c) => c.path.includes('/check-runs') && (c.body?.status as string) === 'completed',
    );

  it('keeps the check when the app was never granted the comment permission', async () => {
    gh.createStatus = 403;
    await expect(complete()).resolves.toBeUndefined();
    expect(checkCompleted()).toBe(true);
  });

  it('stops asking a repo that refused it, and asks again after the hour', async () => {
    gh.createStatus = 403;
    await complete();
    const asked = commentCalls().length;

    gh.calls = [];
    h.redis.clear();
    await complete();
    // Second run, same hour, same repo: the refusal is remembered rather than
    // re-earned on every push.
    expect(commentCalls()).toHaveLength(0);
    expect(asked).toBeGreaterThan(0);

    _resetCommentRefusals();
    gh.calls = [];
    gh.createStatus = 201;
    await complete();
    // The permission was granted in the meantime; nothing had to be redeployed.
    expect(commentCalls().map((c) => c.method)).toEqual(['POST']);
  });

  it('does not silence a repo because one pull request vanished', async () => {
    // A PR closed and deleted while the suite ran answers 404. That is about
    // this pull request and nothing else — treating it as "we may not comment
    // here" would cost an hour of reports on every other PR in the repo.
    gh.createStatus = 404;
    await expect(complete()).resolves.toBeUndefined();

    gh.calls = [];
    gh.createStatus = 201;
    h.redis.clear();
    await complete();
    expect(commentCalls().map((c) => c.method)).toEqual(['POST']);
  });

  it('posts a fresh comment when somebody deleted the old one', async () => {
    await complete();
    gh.calls = [];
    gh.patchStatus = 404;
    usePrisma(runRow({ failures: 2, failedCount: 2 }));
    await complete();

    expect(commentCalls().map((c) => c.method)).toEqual(['PATCH', 'POST']);
  });

  it('retries a rate limit instead of dropping the report', async () => {
    // 429 is weather. Swallowing it here would mean the run that found three
    // real bugs reported them nowhere, which is the one outcome this file
    // exists to prevent — so it throws, and the queue's backoff handles it.
    gh.createStatus = 429;
    await expect(complete()).rejects.toThrow(/rate-limit/i);
    expect(checkCompleted()).toBe(true);
  });

  it('reads a 403 that is really a rate limit as one', async () => {
    gh.createStatus = 403;
    gh.rateLimitHeaders = true;
    await expect(complete()).rejects.toThrow();
    // And it did NOT blacklist the repo for an hour over a temporary throttle.
    gh.calls = [];
    gh.createStatus = 201;
    gh.rateLimitHeaders = false;
    h.redis.clear();
    await complete();
    expect(commentCalls().map((c) => c.method)).toEqual(['POST']);
  });
});

// ─── Tenancy ─────────────────────────────────────────────────────────────────

describe('org isolation', () => {
  it('reads the run inside the job’s org, and touches GitHub for nothing else', async () => {
    await processChecks({ orgId: 'org_someone_else', runId: RUN, phase: 'completed' });

    expect(runFindFirstArgs.every((a) => typeof a.where.orgId === 'string' && a.where.orgId !== '')).toBe(true);
    expect(runFindFirstArgs[0]!.where.orgId).toBe('org_someone_else');
    // No token minted, no check, no comment: another org's run id is not a run.
    expect(gh.calls).toHaveLength(0);
  });
});

// ─── What the comment says ───────────────────────────────────────────────────

const base: CheckEvidence = {
  run: {
    id: RUN,
    status: 'FAILED',
    commitSha: SHA,
    prNumber: PR,
    passedCount: 9,
    failedCount: 1,
    flakyCount: 0,
    totalCount: 10,
    errorMessage: null,
    gateBlocking: false,
  },
  environment: { name: 'Preview', kind: 'PREVIEW' },
  failures: [
    {
      test: { name: 'Checkout completes', filePath: 'tests/checkout.spec.ts', code: null },
      status: 'FAILED',
      errorMessage: 'expect(locator).toBeVisible() failed',
      step: null,
      verdict: { verdict: 'REAL_BUG', confidence: 0.91, explanation: 'The pay button is missing.' },
      fixProposed: false,
    },
  ],
  webUrl: 'https://qaai.example.com',
};

const evidence = (over: Partial<CheckEvidence> = {}): CheckEvidence => ({ ...base, ...over });

const output = { title: '1 failed — 1 looks like a real bug.', summary: 'SUMMARY', text: 'TEXT' };

describe('the body', () => {
  it('carries the marker that makes it one comment forever', () => {
    // Without this the finder never matches and every push posts a new comment.
    expect(buildPrComment(base, output)).toContain(PR_COMMENT_MARKER);
  });

  it('names the failing tests and links the run', async () => {
    await complete();
    const body = gh.comments[0]!.body;
    expect(body).toContain('Checkout completes 0');
    expect(body).toContain('https://qaai.example.com/runs/run_1');
  });

  it('leads with counts, and does not say the triage sentence twice', async () => {
    // The check's own title carries the triage sentence, and so does the first
    // line of its summary. Reusing the title as the heading put the same
    // sentence an inch above itself.
    await complete();
    const [, heading, , first] = gh.comments[0]!.body.split('\n');
    expect(heading).toBe('### ❌ QAAI — 1 failed, 9 passed');
    expect(first).toBe('**1 is not triaged yet.**');
  });

  it('shows the gate verdict when the gate blocked', async () => {
    usePrisma(runRow({ gateResult: { passed: false } }));
    await complete();
    expect(gh.comments[0]!.body).toContain('quality gate is blocking');
  });

  it('expands a short failure list and collapses a long one', () => {
    const short = buildPrComment(base, output);
    expect(short).toContain('<details open>');

    const many = evidence({ failures: Array.from({ length: 9 }, () => base.failures[0]!) });
    expect(buildPrComment(many, output)).toContain('<details>');
  });

  it('links a public run when one can be read, and offers to make one otherwise', () => {
    const linked = buildPrComment(base, output, {
      available: true,
      url: 'https://qaai.example.com/share/tok',
    });
    expect(linked).toContain('https://qaai.example.com/share/tok');
    expect(linked).not.toContain('Create a read-only link');

    // Nothing is published on QAAI's own initiative — the reviewer is told the
    // link exists to be made, and by whom.
    const offered = buildPrComment(base, output, { available: true, url: null });
    expect(offered).toContain('Create a read-only link');

    // A deployment without the share surface says neither.
    const plain = buildPrComment(base, output, { available: false, url: null });
    expect(plain).not.toContain('Create a read-only link');
    expect(plain).not.toContain('/share/');
  });

  it('drops the failure list whole rather than truncating into broken markup', () => {
    const huge = { ...output, text: 'x'.repeat(200_000) };
    const body = buildPrComment(base, huge);

    expect(body.length).toBeLessThanOrEqual(60_000);
    // The cut is announced rather than being a body that ends mid-sentence.
    expect(body).toContain('too long to fit in a comment');
    expect(body).toContain(PR_COMMENT_MARKER);
    expect(body).not.toContain('<details');
  });
});

// ─── Quarantine: the fields are the source, not the arithmetic ───────────────

/**
 * The producer's half of the quarantine fix.
 *
 * `apps/api/src/lib/github-app.ts` already knew how to label a suppressed
 * failure and how to keep a quarantine-only run out of the red — it just had
 * nothing to read. This file selected neither `Run.quarantinedFailedCount` nor
 * the test's two quarantine columns, so every surface fell back to inferring
 * the suppressed count by subtracting `failedCount` from the number of
 * FAILED/TIMED_OUT rows it happened to be handed. That subtraction is exact
 * only while the `results.where` above matches the counters exactly, and it
 * can say nothing at all about WHICH test was suppressed.
 *
 * So these three tests are about provenance, and each one fails in a different
 * way if a field stops being selected:
 *
 *   • per-failure labelling needs `quarantined` on the test row;
 *   • an expired quarantine needs `quarantineExpiresAt` beside it, and
 *     `quarantineSuppresses` rather than the raw flag;
 *   • the run-level count needs the column, which is why the fixture makes the
 *     column and the subtraction DISAGREE.
 */
describe('a check for a run with a quarantined failure', () => {
  const completedCheck = () =>
    gh.calls.find((c) => c.path.includes('/check-runs') && c.body?.status === 'completed')?.body ??
    null;

  it('names the suppressed test rather than reporting a bare count', async () => {
    /*
     * Two failures, one of them suppressed: the run's own counters say one
     * failure gates and one was quarantined. A reviewer has to be able to tell
     * WHICH, and a count cannot.
     */
    usePrisma(
      runRow({
        failures: 2,
        failedCount: 1,
        quarantinedFailedCount: 1,
        quarantine: [{ quarantined: true, quarantineExpiresAt: null }, NOT_QUARANTINED],
      }),
    );

    await complete();
    const body = gh.comments[0]!.body;

    // Both are listed — a failure dropped from the body is a failure nobody
    // sees again — and exactly one carries the label.
    expect(body).toContain('Checkout completes 0');
    expect(body).toContain('Checkout completes 1');
    expect(body.match(/quarantined, so it did not fail this check/g)).toHaveLength(1);
    const labelled = body.slice(body.indexOf('### Checkout completes 0'));
    expect(labelled.split('### Checkout completes 1')[0]).toContain('quarantined, so it did not');

    // And it is reported as a FAILURE, never as a pass and never as a skip.
    expect(body).toContain('1 quarantined and failing');
    expect(body).toContain('They are still failing');
  });

  it('does not hold the merge when every failure was suppressed', async () => {
    usePrisma(
      runRow({
        status: 'PASSED',
        failures: 1,
        failedCount: 0,
        quarantinedFailedCount: 1,
        quarantine: [{ quarantined: true, quarantineExpiresAt: null }],
      }),
    );

    await complete();

    // `neutral`, not `success`: GitHub does not block on it, and the failure
    // stays visible. Green over a failure somebody switched off is the lie.
    expect(completedCheck()?.conclusion).toBe('neutral');
    expect(gh.comments[0]!.body).toContain('1 quarantined and failing');
  });

  it('gates again once the quarantine has run out', async () => {
    /*
     * The flag is STILL TRUE — expiry deliberately does not clear it, so the
     * reason survives — and the expiry is yesterday. Reading the flag raw here
     * would label this failure as suppressed and let the check go neutral over
     * a test that is gating again, which is the quietest possible way to lose
     * a real failure.
     */
    usePrisma(
      runRow({
        failures: 1,
        failedCount: 1,
        quarantinedFailedCount: 0,
        quarantine: [
          { quarantined: true, quarantineExpiresAt: new Date(Date.now() - 86_400_000) },
        ],
      }),
    );

    await complete();
    const body = gh.comments[0]!.body;

    expect(completedCheck()?.conclusion).toBe('failure');
    expect(body).not.toContain('quarantined, so it did not fail this check');
    expect(body).not.toContain('quarantined and failing');
  });

  it('reports the run’s own suppressed count, not one inferred from the rows it read', async () => {
    /*
     * The drift, made to happen. The run counted three suppressed failures;
     * the `results` filter put ONE of them in front of this processor — which
     * is what a shard-scoped or status-narrowed `where` produces. Subtracting
     * `failedCount` from the rows in hand would answer 1, and the per-failure
     * flags would also answer 1. Only the column answers 3, and 3 is the
     * number that is true about the run.
     */
    usePrisma(
      runRow({
        status: 'PASSED',
        failures: 1,
        failedCount: 0,
        quarantinedFailedCount: 3,
        quarantine: [{ quarantined: true, quarantineExpiresAt: null }],
      }),
    );

    await complete();

    expect(gh.comments[0]!.body).toContain('3 quarantined and failing');
    expect(gh.comments[0]!.body).toContain('3 failing test(s) are quarantined');
  });
});
