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

const h = vi.hoisted(
  (): {
    prisma: Record<string, unknown>;
    redis: Map<string, string>;
    /** Job ids the processor enqueued. The re-report's id carries the generation. */
    jobs: Array<{ jobId: string; data: unknown }>;
  } => ({
    prisma: {},
    redis: new Map(),
    jobs: [],
  }),
);

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
    async add(_name: string, data: unknown, opts?: { jobId?: string }): Promise<void> {
      h.jobs.push({ jobId: opts?.jobId ?? '', data });
    }
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
  /** The pull request's changed files, for patch coverage. */
  prFiles: [] as Array<{ filename: string; previous_filename?: string }>,
  filesStatus: 200,
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

    // The pull request's changed files — the diff patch coverage is scored over.
    if (path.includes(`/pulls/${PR}/files`)) {
      if (gh.filesStatus !== 200) return reply(gh.filesStatus, { message: 'nope' });
      return reply(200, gh.prFiles);
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
  /** `Project.gateRules`. An empty list means the documented default applies. */
  gateRules?: unknown;
  prNumber?: number | null;
  /** `Project.repoFullName`. Null is a project with no repository connected. */
  repoFullName?: string | null;
  failures?: number;
  /**
   * `Run.selectionSource`. DEFAULTED TO NULL, which is UNKNOWN — a run written
   * before the column existed — and is NOT `FULL_SUITE`. The gate withholds a
   * suite-wide claim on it, so a fixture that left the key absent would test
   * the absent-selection arm for ever and never the column.
   */
  selectionSource?: string | null;
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
    skippedCount: 0,
    totalCount: 10,
    errorMessage: null,
    selectionSource: over.selectionSource ?? null,
    gateResult: over.gateResult ?? null,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:05:00Z'),
    project: {
      id: 'proj_1',
      repoFullName: over.repoFullName === undefined ? REPO : over.repoFullName,
      repoInstallationId: '42',
      gateRules: over.gateRules ?? [],
      quarantineBudgetPercent: null,
    },
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

/**
 * Records what the processor asked the database for, so scoping is assertable.
 *
 * `select` is in the type because the fake already records it and a test needs
 * it: `Run.selectionSource` decides whether `MIN_PASS_RATE` may publish a
 * suite-wide pass, and a read that stopped asking for the column would quietly
 * go back to claiming one. A recorder that drops the field it was handed makes
 * that regression invisible.
 */
const runFindFirstArgs: Array<{
  where: { id: string; orgId: string };
  select?: Select;
}> = [];

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

/**
 * Everything the post-triage re-score reads, beside the run row.
 *
 * Shaped as fixtures rather than stubbed functions because the point of these
 * tests is the gate's ANSWER: a stub that returned "blocked" would assert that
 * a mock was called, and the defect being covered here is precisely that the
 * gate's answer was computed from inputs that did not exist yet.
 */
interface ResultRow {
  testId: string;
  status: string;
  priority: string;
  type: string;
  name: string;
  verdict: string | null;
  /** The suppression, so the guard can be shown to honour the rule's exclusions. */
  quarantined?: boolean;
  quarantineExpiresAt?: Date | null;
  /** The typed not-run column, and the tag an older row carries instead. */
  notRunKind?: string | null;
  errorMessage?: string | null;
  /** `TriageVerdict.reviewState` and the override, so the human can be shown to win. */
  reviewState?: string;
  overriddenTo?: string | null;
  mutationDetected?: number | null;
  mutationUndetected?: number | null;
  mutationExcluded?: number | null;
  mutationScore?: number | null;
}

interface FindingRow {
  kind: string;
  severity: string;
  code: string;
  location: string;
  mutedAt: Date | null;
  testName?: string;
}

interface World {
  row: ReturnType<typeof runRow> | null;
  results?: ResultRow[];
  findings?: FindingRow[];
  coverage?: {
    percent: number | null;
    denominator: number;
    covered: number;
    createdAt: Date;
    commitSha: string | null;
  } | null;
  /**
   * Coverage inventory rows, as the gate's own read selects them.
   *
   * `waiver` is part of the row and not an extra: `CoverageItem.status` is a
   * MATERIALISED answer and the `CoverageWaiver` row is the authority, so a
   * fixture that could not carry the waiver could not express a lapsed
   * exclusion — which is the case that used to inflate the percentage printed
   * on a pull request.
   */
  items?: Array<{
    key: string;
    status: string;
    label: string;
    waiver?: { expiresAt: Date | null } | null;
  }>;
  /** Tests the impact analysis attributes the diff against. */
  tests?: Array<{ id: string; name: string; filePath: string; code: string | null }>;
  /**
   * `SuppressionEvent` rows for this run.
   *
   * The POST-TRIAGE re-score is the first moment both halves exist — triage
   * writes these AFTER the finaliser ran — which is why the subtraction from
   * `failedCount` happens here and not there. Defaulted to EMPTY and not
   * absent: empty is "triage silenced nothing", which is the ordinary case.
   */
  ledger?: Array<{
    kind: string;
    sourceId: string | null;
    suppressed: number;
    inForce: boolean;
  }>;
  /** Make one read fail, to prove the re-score fails toward the stored gate. */
  failResultsRead?: boolean;
  /** Make the LEDGER read fail. A read that failed is not "nothing was suppressed". */
  failLedgerRead?: boolean;
}

const result = (over: Partial<ResultRow> = {}): ResultRow => ({
  testId: 'test_0',
  status: 'FAILED',
  priority: 'CRITICAL_PATH',
  type: 'E2E',
  name: 'Checkout completes 0',
  verdict: null,
  ...over,
});

/** Writes the re-score made, so idempotence is asserted against the traffic. */
const runUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

/**
 * Reads the re-score made.
 *
 * Counted because one of the guards is about COST rather than about a verdict:
 * the sweep must not re-score a run whose failures are still untriaged, and
 * doing so anyway produces the same gate and writes nothing — so the only thing
 * a test can notice is the four reads it did not have to do. A mutation test
 * that nothing observes is a guard that will be deleted by the next person who
 * reads it as dead weight.
 */
const resultReads = { count: 0, wheres: [] as Array<Record<string, unknown>> };

/** Every argument the ledger read was given, so its scoping is assertable. */
const ledgerReads: Array<{ where?: Record<string, unknown>; select?: Select; take?: number }> = [];

function useWorld(world: World): void {
  const { row } = world;
  const results = world.results ?? [];

  h.prisma = {
    run: {
      findFirst: async (args: { where: { id: string; orgId: string }; select?: Select }) => {
        runFindFirstArgs.push(args);
        if (!row) return null;
        if (args.where.id !== row.id || args.where.orgId !== ORG) return null;
        return applySelect(row, args.select);
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        runUpdates.push(args);
        return { count: 1 };
      },
    },
    healProposal: { findMany: async () => [] },
    /**
     * The suppression ledger, which the re-score reads through
     * `suppressionTalliesFor` (processors/run.ts — ONE definition, because a
     * `groupBy` here would count rows where that function counts distinct
     * `sourceId`s and two surfaces would report different numbers for one run).
     *
     * The ARGS are recorded as well as answered: this read is what takes a
     * silenced failure off the gate, so the `inForce`/`kind` scoping is the
     * property worth holding — a fake that shrugged at them would let the
     * subtraction count an EXPIRED mute and relabel a run PASSED on a
     * suppression that had run out.
     */
    suppressionEvent: {
      findMany: async (
        args: { where?: Record<string, unknown>; select?: Select; take?: number } = {},
      ) => {
        ledgerReads.push(args);
        if (world.failLedgerRead) throw new Error('the ledger table went away');
        const rows = (world.ledger ?? []).filter((row) => {
          // `args.where` is already `Record<string, unknown>`; the cast that
          // used to be here changed nothing.
          const kind = (args.where ?? {}).kind as { not?: string } | undefined;
          if (kind?.not !== undefined && row.kind === kind.not) return false;
          return true;
        });
        const page = typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
        return page.map((row) => applySelect(row, args.select));
      },
    },
    testResult: {
      findMany: async (
        args: { where?: Record<string, unknown>; select?: Select } = {},
      ) => {
        resultReads.count += 1;
        resultReads.wheres.push(args.where ?? {});
        if (world.failResultsRead) throw new Error('the database went away');

        const rows = results.map((r) => ({
          testId: r.testId,
          status: r.status,
          durationMs: 100,
          retriedAndPassed: false,
          notRunKind: r.notRunKind ?? null,
          errorMessage: r.errorMessage ?? null,
          mutationScore: r.mutationScore ?? null,
          mutationDetected: r.mutationDetected ?? null,
          mutationUndetected: r.mutationUndetected ?? null,
          mutationExcluded: r.mutationExcluded ?? null,
          test: {
            name: r.name,
            priority: r.priority,
            type: r.type,
            quarantined: r.quarantined ?? false,
            quarantineExpiresAt: r.quarantineExpiresAt ?? null,
          },
          verdict: r.verdict
            ? {
                verdict: r.verdict,
                reviewState: r.reviewState ?? 'PENDING',
                overriddenTo: r.overriddenTo ?? null,
              }
            : null,
        }));

        /*
         * The guard's read is narrow — the rows that can carry a verdict or be
         * waiting for one — and applying its `where` is what lets a test see
         * that the full scoring did NOT happen. The two reads are otherwise
         * indistinguishable from outside.
         */
        const narrow = Array.isArray((args.where as { OR?: unknown[] } | undefined)?.OR);
        const chosen = narrow
          ? rows.filter(
              (row) =>
                row.status === 'FAILED' || row.status === 'TIMED_OUT' || row.verdict !== null,
            )
          : rows;

        // Projected through the `select`, as Prisma would: a column the
        // processor forgot to ask for must be `undefined` here too.
        return chosen.map((row) => applySelect(row, args.select));
      },
    },
    finding: {
      findMany: async () =>
        (world.findings ?? []).map((f) => ({
          kind: f.kind,
          severity: f.severity,
          code: f.code,
          location: f.location,
          mutedAt: f.mutedAt,
          testResult: {
            test: {
              name: f.testName ?? 'a11y: checkout',
              quarantined: false,
              quarantineExpiresAt: null,
            },
          },
        })),
    },
    coverageSnapshot: { findFirst: async () => world.coverage ?? null },
    coverageItem: { findMany: async () => world.items ?? [] },
    test: {
      /**
       * `count` HONOURS `quarantined: true`, and that is not tidiness.
       *
       * It used to return `results.length` for every call, so
       * `quarantineHealth` read 10 of 10 tests quarantined on EVERY fixture in
       * this file and appended a BLOCK — which meant `GateResult.passed` was
       * false in every test here and no test could assert a passing gate at
       * all. A where-blind fake does not just hide a dropped filter; it makes a
       * whole column of assertions unavailable.
       */
      count: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        where?.quarantined === true
          ? results.filter((r) => r.quarantined === true).length
          : results.length,
      findMany: async ({ select }: { select?: Select } = {}) =>
        // Two callers: the quarantine row sample, and the suite the impact
        // analysis attributes a diff against. They ask for different columns.
        select && 'code' in select
          ? (world.tests ?? []).map((test) => ({
              id: test.id,
              name: test.name,
              filePath: test.filePath,
              code: test.code,
              spec: null,
              tags: [],
              feature: null,
              priority: 'IMPORTANT',
            }))
          : [],
    },
  };
}

/** The old shape, kept so the comment tests read as they did. */
function usePrisma(row: ReturnType<typeof runRow> | null): void {
  useWorld({ row, results: [result()] });
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
  gh.prFiles = [];
  gh.filesStatus = 200;
  h.redis.clear();
  h.jobs.length = 0;
  runUpdates.length = 0;
  resultReads.count = 0;
  resultReads.wheres.length = 0;
  ledgerReads.length = 0;
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

// ─── What chose the tests, and what triage silenced ──────────────────────────

/*
 * THE TWO THINGS THE POST-TRIAGE RE-SCORE NOW READS, and neither had a
 * production caller before this round.
 *
 *   · `Run.selectionSource` — the column had a WRITER (POST /runs) and no
 *     reader, so `MIN_PASS_RATE` scored 100% over an eleven-test impact
 *     selection and every surface rendered it as a statement about the suite.
 *   · `SuppressionEvent` — triage writes these AFTER the finaliser has already
 *     written the counters, so this re-score is the FIRST moment both halves
 *     exist. Without the subtraction the product shipped the worst of both: the
 *     ledger said N failures were silenced and `Run.status` stayed FAILED, so
 *     the customer was blocked AND told the failure had been handled.
 */
describe('the re-score reads what chose the tests', () => {
  const minPassRate = [{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }];
  const tenPassing = () =>
    Array.from({ length: 10 }, (_, i) =>
      result({ testId: `p${i}`, name: `test ${i}`, status: 'PASSED' }),
    );
  const passing = (selectionSource?: string | null) =>
    runRow({
      status: 'PASSED',
      failures: 0,
      failedCount: 0,
      passedCount: 10,
      gateRules: minPassRate,
      ...(selectionSource === undefined ? {} : { selectionSource }),
    });

  const passRate = () =>
    writtenGate()!.evaluations.find((e) => e.detail.startsWith('Pass rate'))!;

  it('publishes the suite-wide pass for a FULL_SUITE run', async () => {
    useWorld({ row: passing('FULL_SUITE'), results: tenPassing() });
    await complete();

    expect(passRate().action).toBe('PASS');
    // No caveat clause: this one IS a verified suite-wide pass.
    expect(passRate().detail).not.toContain('NOT a suite-wide result');
  });

  it('WITHHOLDS the suite-wide pass over an IMPACT selection, and names the mode', async () => {
    useWorld({ row: passing('IMPACT'), results: tenPassing() });
    await complete();

    // 100% of ten impact-selected tests says nothing about the rest of the
    // suite. The pass is withheld; it is NOT converted into a block.
    expect(passRate().action).toBe('UNMEASURED');
    expect(passRate().detail).toContain('selected by IMPACT');
    // WITHHELD, NOT BLOCKED. A rate below the floor would still have failed
    // this rule; converting a sliver's pass into a block would be a block this
    // product invented.
    expect(writtenGate()!.passed).toBe(true);
  });

  it('withholds it on a NULL selection too, because a null is UNKNOWN and not FULL_SUITE', async () => {
    useWorld({ row: passing(null), results: tenPassing() });
    await complete();

    expect(passRate().action).toBe('UNMEASURED');
    expect(passRate().detail).toContain('the run records no selection source');
    /*
     * The sentence NAMES no selection mode, because there is none to name. It
     * does mention FULL_SUITE — "which is not the same fact as FULL_SUITE" —
     * and that clause is the point rather than a leak, so what is asserted is
     * the absence of a CLAIM ("selected by X") and not the absence of the word.
     */
    expect(passRate().detail).not.toContain('selected by');
    expect(passRate().detail).toContain('not the same fact as FULL_SUITE');
  });

  it('reads the column rather than inferring it, so dropping it from the select is detectable', async () => {
    useWorld({ row: passing('FULL_SUITE'), results: tenPassing() });
    await complete();

    const read = runFindFirstArgs.find((args) => args.select && 'gateResult' in args.select)!;
    expect(read.select).toMatchObject({ selectionSource: true });
  });

  it('takes a silenced failure off the gate, instead of blocking AND saying it was handled', async () => {
    /*
     * One failure, a known issue silencing it, a gate the failure does not
     * block. Before the ledger reached `runOutcome` here, this run's status
     * stayed FAILED while the ledger recorded the suppression — the exact
     * "worst of both" the subtraction exists to end.
     */
    useWorld({
      row: runRow({
        status: 'FAILED',
        failures: 1,
        failedCount: 1,
        passedCount: 9,
        /*
         * AN EXPLICIT RULE LIST, not `[]`. An empty list means
         * `DEFAULT_GATE_RULES`, which include `BLOCK_ON_VERDICT` — so the gate
         * would block on the REAL_BUG verdict below and `gatePassed: false`
         * would decide the status whatever the ledger said. This run's one
         * failure does not trip a 50% floor, which is what leaves the
         * subtraction as the only thing deciding PASSED or FAILED.
         */
        gateRules: [{ kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'BLOCK' }],
        selectionSource: 'FULL_SUITE',
      }),
      results: [
        ...Array.from({ length: 9 }, (_, i) =>
          result({ testId: `p${i}`, name: `test ${i}`, status: 'PASSED' }),
        ),
        result({ testId: 'f0', name: 'Checkout completes 0', verdict: 'REAL_BUG' }),
      ],
      ledger: [{ kind: 'MUTE', sourceId: 'ki_1', suppressed: 1, inForce: true }],
    });
    await complete();

    expect(writtenGate()!.passed).toBe(true);
    expect(runUpdates[runUpdates.length - 1]!.data.status).toBe('PASSED');
  });

  it('leaves the same run FAILED when the ledger is empty, so the subtraction is what moved it', async () => {
    /*
     * The other half of the pair. Identical fixture with NO ledger row: the
     * failure still gates, so the test above cannot be passing because the
     * rules happened to clear it.
     */
    useWorld({
      row: runRow({
        status: 'FAILED',
        failures: 1,
        failedCount: 1,
        passedCount: 9,
        gateRules: [{ kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'BLOCK' }],
        selectionSource: 'FULL_SUITE',
      }),
      results: [
        ...Array.from({ length: 9 }, (_, i) =>
          result({ testId: `p${i}`, name: `test ${i}`, status: 'PASSED' }),
        ),
        result({ testId: 'f0', name: 'Checkout completes 0', verdict: 'REAL_BUG' }),
      ],
      ledger: [],
    });
    await complete();

    expect(runUpdates[runUpdates.length - 1]!.data.status).toBe('FAILED');
  });

  it('scopes the ledger read to this run, excludes QUARANTINE, and bounds it', async () => {
    useWorld({
      row: passing('FULL_SUITE'),
      results: tenPassing(),
      ledger: [],
    });
    await complete();

    expect(ledgerReads).toHaveLength(1);
    /*
     * QUARANTINE IS EXCLUDED IN THE QUERY. It arrives as
     * `counts.quarantinedFailed` instead, and counting it twice — once from the
     * counter and once from a ledger row — would take the same failure off the
     * gate twice.
     */
    expect(ledgerReads[0]!.where).toMatchObject({
      runId: RUN,
      orgId: ORG,
      kind: { not: 'QUARANTINE' },
    });
    expect(ledgerReads[0]!.take).toBeGreaterThan(0);
  });

  it('leaves the failure RED when the ledger read fails, rather than reading it as "nothing"', async () => {
    /*
     * A READ THAT FAILED IS NOT "NOTHING WAS SUPPRESSED", and the behaviour
     * here was MEASURED rather than assumed. `suppressionTalliesFor` catches
     * its own error and returns an empty tally, so the re-score SURVIVES and
     * still writes a gate — it does not fail toward the stored answer the way
     * a failed RESULTS read does.
     *
     * What that means for the customer is the safe direction: with no tallies
     * there is nothing to subtract, so the failure keeps gating. The unsafe
     * alternative would be a run relabelled PASSED on the strength of a ledger
     * nobody could read. The log line is what a reader has.
     */
    useWorld({
      row: runRow({
        status: 'FAILED',
        failures: 1,
        failedCount: 1,
        passedCount: 9,
        gateRules: [{ kind: 'MIN_PASS_RATE', ratePercent: 50, action: 'BLOCK' }],
        selectionSource: 'FULL_SUITE',
      }),
      results: [
        ...Array.from({ length: 9 }, (_, i) =>
          result({ testId: `p${i}`, name: `test ${i}`, status: 'PASSED' }),
        ),
        result({ testId: 'f0', name: 'Checkout completes 0', verdict: 'REAL_BUG' }),
      ],
      failLedgerRead: true,
    });
    await complete();

    // A gate IS written, and the failure is still a failure.
    expect(writtenGate()).not.toBeNull();
    expect(runUpdates[runUpdates.length - 1]!.data.status).toBe('FAILED');
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

// ─────────────────────────────────────────────────────────────────────────────
// The gate, re-scored after triage.
//
// THE DEFECT, end to end: `Run.gateResult` is written by the run finaliser,
// which runs BEFORE triage. The rule every new project gets is BLOCK_ON_VERDICT
// REAL_BUG. At finalisation no verdict row exists, so the rule found no
// REAL_BUG verdicts and the gate came back passing — on a run with real
// failures, in the merge box, with a green tick. These tests assert the
// CONCLUSION GitHub is sent and the row that was written, not that a function
// was called, because the bug was that the right function was called at the
// wrong time.
// ─────────────────────────────────────────────────────────────────────────────

/** The body of the last check-runs write, which is what the merge box renders. */
const checkBody = () =>
  [...gh.calls].reverse().find((c) => c.path.includes('/check-runs') && c.method !== 'GET')?.body ??
  null;

const writtenGate = () =>
  runUpdates.length === 0
    ? null
    : (runUpdates[runUpdates.length - 1]!.data.gateResult as {
        passed: boolean;
        evaluations: Array<{ action: string; detail: string }>;
        rescored?: { generation: number; reversedGreen: boolean; reason: string };
      });

/** jsonb does not preserve key order. Everything stored comes back reordered. */
function throughJsonb(value: unknown): unknown {
  const round = (held: unknown): unknown => {
    if (Array.isArray(held)) return held.map(round);
    if (held && typeof held === 'object') {
      return Object.fromEntries(
        Object.entries(held as Record<string, unknown>)
          .reverse()
          .map(([key, inner]) => [key, round(inner)]),
      );
    }
    return held;
  };
  return round(JSON.parse(JSON.stringify(value)));
}

describe('the gate is scored again once the verdicts exist', () => {
  it('reports PROVISIONAL rather than a pass while the failure is untriaged', async () => {
    useWorld({ row: runRow(), results: [result({ verdict: null })] });
    await complete();

    const gate = writtenGate()!;
    const verdictRule = gate.evaluations.find((e) => e.detail.startsWith('Block on REAL_BUG'))!;
    // Not a pass and not a block: nobody has decided yet. The old arithmetic
    // called this "no REAL_BUG verdicts" and showed a green gate.
    expect(verdictRule.action).toBe('UNMEASURED');
    expect(verdictRule.detail).toContain('not been triaged');
  });

  it('turns the merge box red once triage calls it a real bug', async () => {
    // Step one: the run finalises and the gate is scored with no verdicts.
    useWorld({ row: runRow(), results: [result({ verdict: null })] });
    await complete();
    const provisional = throughJsonb(writtenGate());

    // Step two: triage has run. Same run, same check, verdict now exists.
    runUpdates.length = 0;
    gh.calls = [];
    useWorld({
      row: runRow({ gateResult: provisional }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(false);
    expect(checkBody()?.conclusion).toBe('failure');
    // And the run's own status, written through `runOutcome` — the one function
    // allowed to answer "did this run pass" — rather than by a second opinion.
    expect(runUpdates[0]!.data.status).toBe('FAILED');
  });

  it('says out loud that a gate which had reported a pass now blocks', async () => {
    useWorld({ row: runRow(), results: [result({ verdict: null })] });
    await complete();
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    useWorld({
      row: runRow({ gateResult: provisional }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    await complete();

    const rescored = writtenGate()!.rescored!;
    expect(rescored.generation).toBe(2);
    expect(rescored.reversedGreen).toBe(true);
    expect(rescored.reason).toContain('reported a PASS and now BLOCKS');
  });

  it('writes nothing at all on a repeat, so the generation counts decisions', async () => {
    // The sweep ticks every minute and webhooks redeliver, so "runs twice" is
    // the normal case. A re-score that rewrote the row every time would be an
    // accumulating counter wearing the word supersede.
    useWorld({ row: runRow(), results: [result({ verdict: 'REAL_BUG' })] });
    await complete();
    expect(runUpdates).toHaveLength(1);
    const stored = throughJsonb(writtenGate());

    useWorld({ row: runRow({ gateResult: stored }), results: [result({ verdict: 'REAL_BUG' })] });
    await complete();
    expect(runUpdates).toHaveLength(1);
  });

  it('may not relabel a run that has left PASSED or FAILED', async () => {
    useWorld({ row: runRow(), results: [result({ verdict: 'REAL_BUG' })] });
    await complete();
    // A cancel that landed while this was running is terminal; so is an ERRORED
    // run, which measured nothing.
    expect(runUpdates[0]!.where).toMatchObject({ status: { in: ['PASSED', 'FAILED'] } });
  });

  it('never re-scores a cancelled run', async () => {
    useWorld({ row: runRow({ status: 'CANCELLED' }), results: [result({ verdict: 'REAL_BUG' })] });
    await complete();
    // "Nobody wanted this answer" must not be replaced with a gate verdict
    // about a suite that never finished.
    expect(runUpdates).toHaveLength(0);
  });

  it('will not score a suite larger than it reads', async () => {
    // Every rule divides by this list, so a capped read would compute a pass
    // rate, a flake rate and a verdict count over the first 5,000 of 6,000
    // results. The finalisation gate at least divided by the whole run.
    useWorld({
      row: runRow({ gateResult: { passed: true, evaluations: [] } }),
      results: Array.from({ length: 5_001 }, (_, i) =>
        result({ testId: `test_${i}`, verdict: 'REAL_BUG' }),
      ),
    });
    await complete();

    expect(runUpdates).toHaveLength(0);
    expect(checkBody()?.status).toBe('completed');
  });

  it('fails toward the stored gate when an input cannot be read', async () => {
    useWorld({
      row: runRow({ gateResult: { passed: true, evaluations: [] } }),
      results: [result({ verdict: 'REAL_BUG' })],
      failResultsRead: true,
    });
    await expect(complete()).resolves.toBeUndefined();

    // Nothing written, and the check still went out: a check carrying the older
    // verdict beats no check at all.
    expect(runUpdates).toHaveLength(0);
    expect(checkBody()?.status).toBe('completed');
  });
});

describe('a re-score may not drop an evaluation it cannot recompute', () => {
  /*
   * THE DEFECT, and the severe half of it. The environment evaluation is
   * APPENDED by the run finaliser — it is the only caller that knows which
   * tests were blocked and why — so `evaluateGates` cannot produce it and the
   * re-score, which replaces the evaluations wholesale, deleted it.
   *
   * Reachable: a sharded run whose every selected test is of a type this
   * deployment cannot execute takes the derived-unattemptable BLOCK, and
   * `completeShardedRun` leaves `forcedStatus` null, so the run is FAILED
   * rather than ERRORED — and therefore re-scored. The gate was rewritten
   * `passed: true`, `Run.status` was relabelled PASSED, and the reason said
   * "2 evaluation(s) changed once the verdicts existed" about verdicts that had
   * not changed. A green merge box over a run that executed nothing.
   */
  const ENVIRONMENT_BLOCK = {
    rule: { kind: 'ENVIRONMENT_AVAILABLE', action: 'BLOCK' },
    passed: false,
    action: 'BLOCK',
    detail:
      'Environment — nothing in this run could be attempted: 2 test(s) are of a type this ' +
      'deployment cannot execute (k6 load, lighthouse) — install the missing tool on the worker. ' +
      'There is no verdict here, so nothing may merge on the strength of it.',
  };

  /** A run on which nothing could be attempted: every row unsupported. */
  const unattemptable = () =>
    useWorld({
      row: runRow({
        status: 'FAILED',
        failures: 0,
        failedCount: 0,
        passedCount: 0,
        gateResult: throughJsonb({ passed: false, evaluations: [ENVIRONMENT_BLOCK] }),
      }),
      results: [
        result({ testId: 'k6', name: 'k6 load', status: 'SKIPPED', notRunKind: 'UNSUPPORTED' }),
        result({
          testId: 'lh',
          name: 'lighthouse',
          status: 'SKIPPED',
          notRunKind: 'UNSUPPORTED',
          type: 'PERFORMANCE',
        }),
      ],
    });

  it('carries the environment BLOCK forward instead of clearing it', async () => {
    unattemptable();
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(false);
    const environment = gate.evaluations.find((e) => e.detail.startsWith('Environment —'))!;
    expect(environment.action).toBe('BLOCK');
    // Verbatim: the detail is the whole message, and it is what the check
    // summary, the chat alert and the CLI print.
    expect(environment.detail).toBe(ENVIRONMENT_BLOCK.detail);
  });

  it('does not relabel the run PASSED on the strength of the evaluation it dropped', async () => {
    unattemptable();
    await complete();

    expect(runUpdates[0]!.data.status).toBe('FAILED');
    expect(checkBody()?.conclusion).toBe('failure');
  });

  it('says it carried it, and no longer blames the verdicts', async () => {
    unattemptable();
    await complete();

    const rescored = writtenGate()!.rescored!;
    expect(rescored.reason).toContain('carried forward');
    expect(rescored.reason).toContain('ENVIRONMENT_AVAILABLE');
    expect(rescored.reason).not.toContain('once the verdicts existed');
  });
});

describe('a test nobody could attempt is out of the pass rate', () => {
  /*
   * `GateInput.results` had no way to say "this did not run", so the eleven
   * tests behind a dead staging box counted eleven times against the pass rate.
   * The counters were fixed for exactly this and the rules were not.
   */
  const minPassRate = [{ kind: 'MIN_PASS_RATE', ratePercent: 90, action: 'BLOCK' }];

  /*
   * `selectionSource: 'FULL_SUITE'` IS DECLARED, and it has to be.
   *
   * These tests are about the DENOMINATOR — which rows the pass rate divides
   * by — and `MIN_PASS_RATE` now also asks what chose the tests. A run whose
   * selection is UNRECORDED (null) cannot publish a suite-wide 100%, so with
   * the default fixture these would report UNMEASURED and stop testing the
   * denominator at all. The runs below execute the whole suite, so saying so is
   * what makes the subject of the test the subject of the test.
   *
   * The null arm is pinned separately, under "what chose the tests".
   */
  const run = () =>
    runRow({
      status: 'PASSED',
      failures: 0,
      failedCount: 0,
      passedCount: 8,
      gateRules: minPassRate,
      selectionSource: 'FULL_SUITE',
    });

  const eightPassing = () =>
    Array.from({ length: 8 }, (_, i) =>
      result({ testId: `p${i}`, name: `test ${i}`, status: 'PASSED' }),
    );

  it('reads the typed column and leaves those rows out of the denominator', async () => {
    useWorld({
      row: run(),
      results: [
        ...eightPassing(),
        result({ testId: 'b1', name: 'checkout', status: 'SKIPPED', notRunKind: 'BLOCKED_BY_ENV' }),
        result({ testId: 'b2', name: 'k6 load', status: 'SKIPPED', notRunKind: 'UNSUPPORTED' }),
      ],
    });
    await complete();

    const rule = writtenGate()!.evaluations.find((e) => e.detail.startsWith('Pass rate'))!;
    // 8/8, not 8/10. The poisoned denominator read 80% and BLOCKED a merge over
    // two tests nobody attempted — a verdict about our own infrastructure,
    // printed as a verdict about the customer's code.
    expect(rule.detail).toContain('100.0% passed (8/8)');
    expect(rule.action).toBe('PASS');
    expect(rule.detail).toContain('2 not attempted and left out');
  });

  it('falls back to the tag for a row written before the column existed', async () => {
    // Every row written before `TestResult.notRunKind` carries the reason as a
    // tag on `errorMessage` and nothing else, so `parseNotRun` is still the only
    // way to classify one.
    useWorld({
      row: run(),
      results: [
        ...eightPassing(),
        result({
          testId: 'b1',
          name: 'checkout',
          status: 'SKIPPED',
          notRunKind: null,
          errorMessage: '[BLOCKED_BY_ENV] the base URL did not answer',
        }),
        result({
          testId: 'b2',
          name: 'cart',
          status: 'SKIPPED',
          notRunKind: null,
          errorMessage: '[BLOCKED_BY_ENV] the base URL did not answer',
        }),
      ],
    });
    await complete();

    const rule = writtenGate()!.evaluations.find((e) => e.detail.startsWith('Pass rate'))!;
    expect(rule.detail).toContain('100.0% passed (8/8)');
    expect(rule.action).toBe('PASS');
  });

  it('keeps a skip that records no reason in the denominator, and says so', async () => {
    // "Not recorded" is a fifth state, not a fifth kind: a plugin that returns
    // SKIPPED with a plain sentence has made no claim about why.
    useWorld({
      row: run(),
      results: [
        ...eightPassing(),
        result({
          testId: 's1',
          name: 'promo',
          status: 'SKIPPED',
          notRunKind: null,
          errorMessage: 'skipped by the spec',
        }),
      ],
    });
    await complete();

    const rule = writtenGate()!.evaluations.find((e) => e.detail.startsWith('Pass rate'))!;
    expect(rule.detail).toContain('88.9% passed (8/9)');
    expect(rule.detail).toContain('1 skipped result(s) record no reason');
    expect(rule.action).toBe('BLOCK');
  });
});

describe('the re-score scores the columns it says it reads', () => {
  it('reads the mutation columns, where NULL is not a score of 0', async () => {
    // Every column null means mutation testing did not run. A score of 0 means
    // every mutant survived, which is a different fact and a failing one.
    const rules = [{ kind: 'MIN_MUTATION_SCORE', percent: 60, action: 'BLOCK' }];

    useWorld({
      row: runRow({ status: 'PASSED', failures: 0, failedCount: 0, gateRules: rules }),
      results: [result({ status: 'PASSED', verdict: null })],
    });
    await complete();
    const unmeasured = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Mutation score'),
    )!;
    expect(unmeasured.action).toBe('UNMEASURED');
    expect(unmeasured.detail).toContain('every mutant survived');

    runUpdates.length = 0;
    useWorld({
      row: runRow({ status: 'PASSED', failures: 0, failedCount: 0, gateRules: rules }),
      results: [
        result({
          status: 'PASSED',
          verdict: null,
          mutationScore: 10,
          mutationDetected: 10,
          mutationUndetected: 90,
          mutationExcluded: 4,
        }),
      ],
    });
    await complete();
    const measured = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Mutation score'),
    )!;
    expect(measured.action).toBe('BLOCK');
    expect(measured.detail).toContain('10% of 100 valid mutant(s)');
  });

  it('lets a human override beat the model, as the finaliser does', async () => {
    // The model called it a flake; a person said it is a real bug. A gate scored
    // against the model's answer would re-open a merge a human had closed.
    useWorld({
      row: runRow(),
      results: [
        result({
          status: 'FAILED',
          priority: 'CRITICAL_PATH',
          verdict: 'FLAKE',
          reviewState: 'OVERRIDDEN',
          overriddenTo: 'REAL_BUG',
        }),
      ],
    });
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(false);
    expect(checkBody()?.conclusion).toBe('failure');
  });
});

describe('a finding can now hold a merge', () => {
  const noCriticals = [
    { kind: 'MAX_FINDINGS', atOrAbove: 'CRITICAL', onlyKinds: [], max: 0, action: 'BLOCK' },
  ];

  const greenRun = (over: Partial<Parameters<typeof runRow>[0]> = {}) =>
    runRow({ status: 'PASSED', failures: 0, failedCount: 0, passedCount: 10, ...over });

  it('BLOCKS a run whose tests all passed but which carries a critical violation', async () => {
    // The accessibility plugin has always said this: a violation is
    // information, and "whether it blocks a merge is a quality-gate decision".
    // No such rule existed, so the decision was always "no".
    useWorld({
      row: greenRun({ gateRules: noCriticals }),
      results: [result({ status: 'PASSED', verdict: null, type: 'ACCESSIBILITY' })],
      findings: [
        {
          kind: 'ACCESSIBILITY',
          severity: 'CRITICAL',
          code: 'color-contrast',
          location: '/checkout',
          mutedAt: null,
        },
      ],
    });
    await complete();

    expect(writtenGate()!.passed).toBe(false);
    expect(checkBody()?.conclusion).toBe('failure');
  });

  it('does not block on a muted finding, and says it left it out', async () => {
    useWorld({
      row: greenRun({ gateRules: noCriticals }),
      results: [result({ status: 'PASSED', verdict: null, type: 'ACCESSIBILITY' })],
      findings: [
        {
          kind: 'ACCESSIBILITY',
          severity: 'CRITICAL',
          code: 'color-contrast',
          location: '/checkout',
          mutedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    });
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(true);
    // Muted never gates — but a gate that printed "0 findings" while dropping
    // one would be the quarantine defect again in a different table.
    expect(gate.evaluations.some((e) => e.detail.includes('1 muted'))).toBe(true);
  });
});

describe('the vitals rule reads the same capped list the findings rule does', () => {
  /*
   * The breaches ride on the findings list, so the 500-row findings cap drops
   * them too — and `VitalsGateInput` had no way to say so, so
   * `MAX_VITAL_BREACHES max: 0` reported "0 budget breach(es)" and PASSED on a
   * run that had recorded one. `MAX_FINDINGS` already refused exactly this; the
   * sibling rule reading the same truncated list has to refuse it the same way.
   */
  const noBreaches = [{ kind: 'MAX_VITAL_BREACHES', metric: 'ANY', max: 0, action: 'BLOCK' }];

  const capped = (breachAt: 'inside' | 'past') => {
    const noise = Array.from({ length: breachAt === 'past' ? 500 : 2 }, (_, i) => ({
      kind: 'ACCESSIBILITY' as const,
      severity: 'MINOR' as const,
      code: `axe.minor.${i}`,
      location: `/page/${i}`,
      mutedAt: null,
    }));
    return [
      ...noise,
      {
        kind: 'PERFORMANCE' as const,
        severity: 'SERIOUS' as const,
        code: 'performance.budget-exceeded.lcpMs',
        location: '/checkout',
        mutedAt: null,
      },
    ];
  };

  const perfRun = () =>
    runRow({
      status: 'PASSED',
      failures: 0,
      failedCount: 0,
      passedCount: 10,
      gateRules: noBreaches,
    });

  it('will not CLEAR the rule from a breach list the cap could have cut', async () => {
    useWorld({
      row: perfRun(),
      results: [result({ status: 'PASSED', verdict: null, type: 'PERFORMANCE' })],
      findings: capped('past'),
    });
    await complete();

    const rule = writtenGate()!.evaluations.find((e) => e.detail.includes('budget breach'))!;
    // Not a pass: the breach that was recorded lost the race for the cap, and a
    // PASS here is a claim about budgets nobody checked.
    expect(rule.action).toBe('UNMEASURED');
    expect(rule.detail).toContain('capped before it was counted');
  });

  it('still BLOCKS on a breach when the list was not capped', async () => {
    useWorld({
      row: perfRun(),
      results: [result({ status: 'PASSED', verdict: null, type: 'PERFORMANCE' })],
      findings: capped('inside'),
    });
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(false);
    expect(
      gate.evaluations.some((e) => e.detail.includes('1 budget breach(es)') && e.action === 'BLOCK'),
    ).toBe(true);
  });
});

describe('patch coverage reaches the merge box', () => {
  it('BLOCKS a diff that lands on a route with no test', async () => {
    useWorld({
      row: runRow({
        status: 'PASSED',
        failures: 0,
        failedCount: 0,
        gateRules: [{ kind: 'NO_NEW_UNCOVERED_ROUTES', action: 'BLOCK' }],
      }),
      results: [result({ status: 'PASSED', verdict: null })],
      items: [
        { key: 'ROUTE:/checkout', status: 'COVERED', label: '/checkout' },
        { key: 'ROUTE:/promo', status: 'UNCOVERED', label: '/promo' },
      ],
      tests: [
        {
          id: 'test_0',
          name: 'Checkout completes',
          filePath: 'tests/checkout.spec.ts',
          code: "await page.goto('/checkout');",
        },
      ],
    });
    gh.prFiles = [{ filename: 'app/promo/page.tsx' }];
    await complete();

    const gate = writtenGate()!;
    expect(gate.passed).toBe(false);
    expect(gate.evaluations.some((e) => e.detail.includes('/promo'))).toBe(true);
    expect(checkBody()?.conclusion).toBe('failure');
  });

  it('reports UNMEASURED rather than a pass when GitHub will not hand over the diff', async () => {
    // The app was never granted the permission, or the pull request is gone.
    // Either way nobody measured the changed surface, and a gate that passed
    // here would be certifying a thing it never examined.
    useWorld({
      row: runRow({
        status: 'PASSED',
        failures: 0,
        failedCount: 0,
        gateRules: [{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }],
      }),
      results: [result({ status: 'PASSED', verdict: null })],
      items: [{ key: 'ROUTE:/checkout', status: 'COVERED', label: '/checkout' }],
    });
    gh.filesStatus = 403;
    await complete();

    const gate = writtenGate()!;
    const rule = gate.evaluations.find((e) => e.detail.startsWith('Coverage of the changed'))!;
    expect(rule.action).toBe('UNMEASURED');
    expect(gate.passed).toBe(true);
  });

  it('counts a lapsed waiver as a GAP on the merge box, not as excluded', async () => {
    /*
     * ── AN EXPIRED SUPPRESSION MUST NOT SUPPRESS ──────────────────────────────
     *
     * `CoverageItem.status` is materialised: the waiver door writes WAIVED
     * eagerly so the inventory is not stale until the next recomputation. But
     * nothing recomputes on a clock — recompute is enqueued from run, explore,
     * generate, import and analyze-source — so on a quiet project a lapsed
     * exclusion stayed in force for an unbounded time, and WAIVED is the only
     * state that LEAVES the denominator. The percentage this gate printed on a
     * pull request was therefore higher than the truth.
     *
     * This read used to select `{key, status, label}` with no join. It now
     * carries the waiver, and `patchCoverage` demotes a lapsed one.
     */
    useWorld({
      row: runRow({
        status: 'PASSED',
        failures: 0,
        failedCount: 0,
        gateRules: [{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }],
      }),
      results: [result({ status: 'PASSED', verdict: null })],
      items: [
        {
          key: 'ROUTE:/admin/legacy',
          status: 'WAIVED',
          label: '/admin/legacy',
          // Lapsed an hour ago. Nothing has recomputed since.
          waiver: { expiresAt: new Date(Date.now() - 3_600_000) },
        },
      ],
      // `analyzeImpact` needs at least one test to have any vocabulary to
      // attribute a changed path with; this one names a different route.
      tests: [
        {
          id: 'test_0',
          name: 'Checkout completes',
          filePath: 'tests/checkout.spec.ts',
          code: "await page.goto('/checkout');",
        },
      ],
    });
    gh.prFiles = [{ filename: 'app/admin/legacy/page.tsx' }];
    await complete();

    const rule = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Coverage of the changed'),
    )!;
    // In the denominator, and a gap: 0% of one route, which BLOCKS at 80%.
    expect(rule.detail).toContain('1 changed route(s)');
    expect(rule.action).toBe('BLOCK');
  });

  it('keeps excluding a route whose waiver is still in force', async () => {
    // The other half of the same rule. A live waiver still leaves the
    // denominator, so there is nothing left to divide by and the gate reports
    // UNMEASURED rather than 0% — which would read as a failure caused by a
    // decision somebody made on purpose.
    useWorld({
      row: runRow({
        status: 'PASSED',
        failures: 0,
        failedCount: 0,
        gateRules: [{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }],
      }),
      results: [result({ status: 'PASSED', verdict: null })],
      items: [
        {
          key: 'ROUTE:/admin/legacy',
          status: 'WAIVED',
          label: '/admin/legacy',
          waiver: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
        },
      ],
      tests: [
        {
          id: 'test_0',
          name: 'Checkout completes',
          filePath: 'tests/checkout.spec.ts',
          code: "await page.goto('/checkout');",
        },
      ],
    });
    gh.prFiles = [{ filename: 'app/admin/legacy/page.tsx' }];
    await complete();

    const rule = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Coverage of the changed'),
    )!;
    expect(rule.action).toBe('UNMEASURED');
  });

  it('collects a rename as both filenames', async () => {
    // A rename arrives as the new filename plus `previous_filename`. The old
    // path is the one the inventory still has a row for, so dropping it would
    // make every rename look like a pure addition.
    useWorld({
      row: runRow({
        status: 'PASSED',
        failures: 0,
        failedCount: 0,
        gateRules: [{ kind: 'MIN_PATCH_COVERAGE', percent: 80, action: 'BLOCK' }],
      }),
      results: [result({ status: 'PASSED', verdict: null })],
      items: [
        { key: 'ROUTE:/cart', status: 'COVERED', label: '/cart' },
        { key: 'ROUTE:/basket', status: 'UNCOVERED', label: '/basket' },
      ],
      tests: [
        {
          id: 'test_0',
          name: 'Cart',
          filePath: 'tests/cart.spec.ts',
          code: "await page.goto('/cart');",
        },
      ],
    });
    gh.prFiles = [{ filename: 'app/basket/page.tsx', previous_filename: 'app/cart/page.tsx' }];
    await complete();

    const rule = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Coverage of the changed'),
    )!;
    // Both routes are in the changed surface: /cart covered, /basket not.
    expect(rule.detail).toContain('2 changed route(s)');
    expect(rule.action).toBe('BLOCK');
  });
});

describe('the sweep is where "ask again" lives', () => {
  const sweep = () => processChecks({ orgId: '', runId: '', phase: 'sweep' });

  /**
   * The sweep walks runs rather than being handed one.
   *
   * The `prNumber` filter is applied, and nothing else is: the sweep makes TWO
   * queries — the check half asks for pull-request runs on installed repos, the
   * re-score half asks for terminal runs with failures — and a fake that
   * answered both the same way could not tell a test which pass did the work.
   */
  function sweepWorld(world: Parameters<typeof useWorld>[0]): void {
    useWorld(world);
    const base = h.prisma.run as Record<string, unknown>;
    const row = world.row;
    h.prisma = {
      ...h.prisma,
      run: {
        ...base,
        findMany: async (args: { where?: Record<string, unknown> } = {}) => {
          if (!row) return [];
          if (args.where?.prNumber && row.prNumber === null) return [];
          return [
            { id: RUN, orgId: ORG, status: row.status, gateResult: row.gateResult ?? null },
          ];
        },
      },
    };
  }

  it('re-scores a run whose check was already reported, and re-reports it', async () => {
    // A short suite reaches terminal and gets its check long before the triage
    // jobs for its failures have run — so `completed` re-scores a gate whose
    // verdicts still do not exist and nothing ever asks again. This is asking
    // again.
    useWorld({ row: runRow(), results: [result({ verdict: null })] });
    await complete();
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      row: runRow({ gateResult: provisional }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    await sweep();

    expect(writtenGate()!.passed).toBe(false);
    // The job id carries the generation, because a completed job keeps its id:
    // re-adding `check-<run>-completed` is a no-op, and the merge box would
    // keep showing the pre-triage verdict forever.
    expect(h.jobs.map((j) => j.jobId)).toContain(`check-${RUN}-completed-g2`);
  });

  it('leaves a run alone while a failure is still untriaged', async () => {
    // Re-scoring would produce the same UNMEASURED answer, so a project with no
    // triage running must not cost four reads a minute for two hours.
    useWorld({ row: runRow(), results: [result({ verdict: null })] });
    await complete();
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      row: runRow({ gateResult: provisional }),
      results: [result({ verdict: null })],
    });
    resultReads.count = 0;
    await sweep();

    expect(runUpdates).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    /*
     * And it did not pay for the answer it already knew. The guard now READS
     * the failures rather than counting them, because counting them answered a
     * different question than the rule asks (see the test below), so the cost
     * it must not pay is the full scoring: one narrow read of the rows that can
     * carry a verdict, and none of the four reads a re-score makes.
     */
    expect(resultReads.count).toBe(1);
    expect(resultReads.wheres.at(-1)).toMatchObject({
      OR: [{ status: { in: ['FAILED', 'TIMED_OUT'] } }, { verdict: { isNot: null } }],
    });
  });

  it('stops waiting when the rules stop waiting, not when every failure is triaged', async () => {
    /*
     * THE DEFECT, and it is a gate stuck for ever rather than a wrong number.
     * The guard counted `status in (FAILED, TIMED_OUT) AND verdict IS NULL`
     * with no quarantine filter and no priority filter, while the rule it waits
     * for excludes quarantined results and applies `onlyPriorities`. So this
     * run — one CRITICAL_PATH failure now triaged, one untriaged quarantined
     * failure, one untriaged IMPORTANT failure — stayed PROVISIONAL for ever:
     * the rule stopped waiting the moment the critical one was triaged, and the
     * guard never did.
     */
    const stuck = [
      result({ testId: 'c1', name: 'Checkout completes 0', priority: 'CRITICAL_PATH' }),
      result({ testId: 'q1', name: 'flaky cart', priority: 'CRITICAL_PATH', quarantined: true }),
      result({ testId: 'i1', name: 'footer link', priority: 'IMPORTANT' }),
    ];

    useWorld({ row: runRow(), results: stuck });
    await complete();
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      // Triaged a FLAKE rather than a REAL_BUG on purpose: a rule that has
      // already found the verdict it refuses stops waiting for its own reason,
      // which would hide whether the guard honours the quarantine and priority
      // exclusions at all.
      results: [{ ...stuck[0]!, verdict: 'FLAKE' }, stuck[1]!, stuck[2]!],
      row: runRow({ gateResult: provisional }),
    });
    await sweep();

    // The gate is no longer PROVISIONAL: the rule has its answer, and the two
    // untriaged failures it does not read cannot hold it open any longer.
    const verdictRule = writtenGate()!.evaluations.find((e) =>
      e.detail.startsWith('Block on REAL_BUG'),
    )!;
    expect(verdictRule.action).toBe('PASS');
    expect(h.jobs.map((j) => j.jobId)).toContain(`check-${RUN}-completed-g2`);
  });

  it('re-scores a run that will never have a pull request', async () => {
    /*
     * FOUR of the measurement rules — MIN_COVERAGE, MAX_FINDINGS,
     * MIN_MUTATION_SCORE, MAX_VITAL_BREACHES — are assembled only by the
     * re-score, and both of its entry points used to return early without a
     * GitHub-app pull request. So a customer who installs the product the way
     * the README does (packages/cli in their own CI, no app, no PR) configured
     * MIN_COVERAGE 80 and read "not measured" on every run they would ever do.
     * None of those four needs a diff.
     */
    const rules = [
      // The verdict rule as well, because it is what makes a stored gate
      // PROVISIONAL, and only a provisional gate is swept. That is the bound on
      // this fix and it is written down in `sweepRescoreWithoutCheck`.
      { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
      { kind: 'MIN_COVERAGE', percent: 80, action: 'BLOCK' },
    ];
    const push = (over: Parameters<typeof runRow>[0] = {}) =>
      runRow({ prNumber: null, gateRules: rules, ...over });

    useWorld({ row: push(), results: [result({ verdict: null })] });
    await complete();
    // Nothing is reported for a run with no pull request; the gate is the point.
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      row: push({ gateResult: provisional }),
      results: [result({ verdict: 'REAL_BUG' })],
      coverage: {
        percent: 41.5,
        denominator: 200,
        covered: 83,
        createdAt: new Date('2026-10-24T00:00:00Z'),
        commitSha: 'abcdef1234',
      },
    });
    await sweep();

    const gate = writtenGate()!;
    const coverage = gate.evaluations.find((e) => e.detail.startsWith('Surface coverage'))!;
    expect(coverage.action).toBe('BLOCK');
    expect(coverage.detail).toContain('41.5%');
    expect(gate.passed).toBe(false);
  });

  it('writes the gate and reports nothing when there is no check to report', async () => {
    // A project with no repository connected. The gate and the run's status are
    // the whole report, and enqueueing a check phase would be a job that can
    // only return early.
    const detached = (over: Parameters<typeof runRow>[0] = {}) =>
      runRow({ prNumber: null, repoFullName: null, ...over });

    useWorld({ row: detached(), results: [result({ verdict: null })] });
    const provisional = throughJsonb(
      // Nothing posts a check for this run, so the provisional gate is built
      // the way finalisation would have built it rather than by `complete()`.
      {
        passed: true,
        evaluations: [
          {
            rule: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: ['CRITICAL_PATH'] },
            passed: null,
            action: 'UNMEASURED',
            detail: 'Block on REAL_BUG (CRITICAL_PATH) — not measured — 1 failing test(s) have not been triaged',
          },
        ],
        unmeasured: 1,
      },
    );

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      row: detached({ gateResult: provisional }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    await sweep();

    expect(writtenGate()!.passed).toBe(false);
    expect(h.jobs).toHaveLength(0);
    // And no GitHub traffic at all: there is no installation to talk to.
    expect(gh.calls).toHaveLength(0);
  });

  it('does not keep re-scoring a gate that is no longer provisional', async () => {
    useWorld({ row: runRow(), results: [result({ verdict: 'REAL_BUG' })] });
    await complete();
    const settled = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    sweepWorld({
      row: runRow({ gateResult: settled }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    resultReads.count = 0;
    await sweep();

    expect(runUpdates).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    // Once the verdict rule has an answer there is nothing left to wait for, so
    // the sweep stops paying for it. This assertion is the only thing a test can
    // see of that guard — re-scoring anyway produces the same gate and writes
    // nothing — and without it the guard reads as dead weight to be deleted.
    expect(resultReads.count).toBe(0);
  });

  it('keeps waiting on a failure whose quarantine has run out', async () => {
    // An expired quarantine suppresses nothing, so that failure GATES again —
    // and the verdict rule is therefore still waiting on it. Reading
    // `Test.quarantined` raw here would release the guard on a test the rule
    // can see, and the gate would settle without the verdict it is named after.
    const expired = {
      quarantined: true,
      quarantineExpiresAt: new Date(Date.now() - 86_400_000),
    };
    const rows = [
      result({ testId: 'c1', name: 'Checkout completes 0', priority: 'CRITICAL_PATH', verdict: 'FLAKE' }),
      result({ testId: 'q2', name: 'stale cart', priority: 'CRITICAL_PATH', ...expired }),
    ];

    useWorld({ row: runRow(), results: rows });
    await complete();
    const provisional = throughJsonb(writtenGate());

    runUpdates.length = 0;
    h.jobs.length = 0;
    resultReads.count = 0;
    sweepWorld({ row: runRow({ gateResult: provisional }), results: rows });
    await sweep();

    expect(runUpdates).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    /*
     * One read: the guard's. A guard that honoured the expired quarantine would
     * decide the rule had stopped waiting and pay for a full scoring — which
     * produces the same gate and writes nothing, so the reads are the only
     * thing a test can see of it.
     */
    expect(resultReads.count).toBe(1);
  });

  it('refuses to decide whether it is still waiting from a capped read', async () => {
    /*
     * A guard that answered "nothing is waiting" from the first 5,000 of 6,000
     * failures would be a cap deciding a gate. It cannot be seen in the gate —
     * the full scoring refuses on the same cap and writes nothing either way —
     * so what a test can see is that the guard stopped rather than paying for a
     * scoring whose answer it had already decided from a truncated list.
     */
    const provisional = throughJsonb({
      passed: true,
      evaluations: [
        {
          rule: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
          passed: null,
          action: 'UNMEASURED',
          detail: 'Block on REAL_BUG — not measured — untriaged',
        },
      ],
      unmeasured: 1,
    });

    sweepWorld({
      row: runRow({ gateResult: provisional }),
      results: Array.from({ length: 5_001 }, (_, i) =>
        result({ testId: `test_${i}`, name: `test ${i}`, verdict: 'REAL_BUG' }),
      ),
    });
    h.redis.set(`qaai:check:${RUN}`, JSON.stringify({ id: 1, done: true }));
    runUpdates.length = 0;
    resultReads.count = 0;
    await sweep();

    expect(runUpdates).toHaveLength(0);
    expect(resultReads.count).toBe(1);
  });

  it('does not even load a settled run that has no check to re-report', async () => {
    // The second pass reads the stored gate in its own query and tests it
    // BEFORE loading the run, so a tick over a hundred settled runs costs one
    // query rather than a hundred and one. Nothing else can see that guard:
    // loading the run anyway produces the same gate and writes nothing.
    const settled = throughJsonb({
      passed: false,
      evaluations: [
        {
          rule: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
          passed: false,
          action: 'BLOCK',
          detail: 'Block on REAL_BUG — 1 REAL_BUG verdict(s): Checkout completes 0',
        },
      ],
      unmeasured: 0,
    });

    sweepWorld({
      row: runRow({ prNumber: null, repoFullName: null, gateResult: settled }),
      results: [result({ verdict: 'REAL_BUG' })],
    });
    runFindFirstArgs.length = 0;
    await sweep();

    expect(runFindFirstArgs).toHaveLength(0);
    expect(runUpdates).toHaveLength(0);
  });
});

describe('the re-score does not need a GitHub app at all', () => {
  /*
   * `processChecks` returned at the top when no app was configured — correct for
   * the two check phases, and the reason the sweep's re-score never ran for the
   * install most customers have: no app, no pull request, the CLI in their own
   * CI. The sweep's check half is still behind the app; its re-score half needs
   * nothing but the database.
   */
  it('re-scores a provisional gate and touches GitHub for nothing', async () => {
    const appId = process.env.GITHUB_APP_ID;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    vi.resetModules();

    try {
      // A fresh module instance, so its one-shot `appConfig()` reads the
      // environment as a deployment with no app would.
      const { processChecks: withoutApp } = await import('./checks.js');

      const provisional = throughJsonb({
        passed: true,
        evaluations: [
          {
            rule: { kind: 'BLOCK_ON_VERDICT', verdict: 'REAL_BUG', onlyPriorities: [] },
            passed: null,
            action: 'UNMEASURED',
            detail: 'Block on REAL_BUG — not measured — 1 failing test(s) have not been triaged',
          },
        ],
        unmeasured: 1,
      });

      const row = runRow({ prNumber: null, repoFullName: null, gateResult: provisional });
      useWorld({ row, results: [result({ verdict: 'REAL_BUG' })] });
      const base = h.prisma.run as Record<string, unknown>;
      h.prisma = {
        ...h.prisma,
        run: {
          ...base,
          findMany: async () => [{ id: RUN, orgId: ORG, status: row.status, gateResult: provisional }],
        },
      };

      await withoutApp({ orgId: '', runId: '', phase: 'sweep' });

      expect(writtenGate()!.passed).toBe(false);
      expect(gh.calls).toHaveLength(0);
    } finally {
      if (appId !== undefined) process.env.GITHUB_APP_ID = appId;
      if (privateKey !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
      vi.resetModules();
    }
  });
});
