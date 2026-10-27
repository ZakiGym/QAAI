/**
 * Suite health — "is this suite still worth what it costs to run?"
 *
 * Every other read endpoint in this API answers a question about a run. This
 * one answers a question about the SUITE: how much of it is the same test
 * written twice, how much of it would fail to notice a regression, and what
 * that adds up to as a number somebody can put on a dashboard.
 *
 *   GET  /suite-health/:projectId                    the reading, computed now
 *   GET  /suite-health/:projectId/tests/:testId      why one test was flagged
 *   POST /suite-health/:projectId/snapshots          store the reading
 *   GET  /suite-health/:projectId/history            the trend
 *
 * ── WHY THE SNAPSHOT DOOR EXISTS ────────────────────────────────────────────
 *
 * The two reads above are derived and were THROWN AWAY on every request, so rot
 * had no direction: a suite that had been degrading for three weeks looked
 * exactly like one that flaked this morning, and there was nothing for a
 * release to be diffed against. "Is this suite getting worse?" is the premise of
 * the entire suite-health lens and it had no answer, because `SuiteHealthSnapshot`
 * had no writer — a schema entry for a feature that did not exist.
 *
 * `POST .../snapshots` is that writer, and it computes NOTHING NEW. It runs the
 * same `analyzeSuiteHealth` the GET runs, through the same
 * {@link computeSuiteHealth}, and persists what that produced. Five of the ten
 * stored measurements therefore come back NULL from here for ever, and that is
 * the point: see {@link snapshotDataFrom}.
 *
 *   curl -s "$QAAI_API_URL/suite-health/$PROJECT?minSimilarity=0.7" \
 *     -H "authorization: Bearer $QAAI_API_KEY" | jq '.score, .components'
 *
 * The score is returned decomposed on purpose. A single number nobody can take
 * apart is a number nobody trusts, and the first question anyone asks about a
 * 62 is "which part is bad?" — so `components` carries per-component scores,
 * the weight each one actually got, its contribution in points, and a sentence
 * of evidence, plus `formula`, which is the arithmetic written out.
 *
 * Neither read writes a row, quarantines a test, or proposes a deletion — and
 * the analysis module is built so it cannot: every duplicate pair it returns
 * carries `safeToDelete: false`, because a "duplicate" that differs in one
 * assertion is regularly the only test that catches a regression and deleting it
 * is unrecoverable.
 *
 * WHY THE IMPORT BELOW IS A RELATIVE PATH: @qaai/agent exports only its barrel
 * (`"exports": { ".": "./src/index.ts" }`), and adding `suite-health.js` to
 * that barrel is a change to a file this work is not permitted to touch. The
 * relative specifier resolves identically under tsc and tsx. See
 * `needsOwnerDecision` — one line in packages/agent/src/index.ts turns this
 * back into a `@qaai/agent` import.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FIXTURE_PREFIX, suiteHealthSnapshotSchema } from '@qaai/shared';
import type { SuiteHealthSnapshot, SuiteHealthSnapshotData } from '@qaai/shared';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { actorOf, requireAuth, requireRole, requireScope } from '../middleware/auth.js';
import {
  analyzeSuiteHealth,
  extractBehavior,
} from '../../../../packages/agent/src/suite-health.js';
import type {
  HealthComponent,
  SuiteHealthReport,
  SuiteHealthTestInput,
} from '../../../../packages/agent/src/suite-health.js';

export const suiteHealthRouter: Router = Router();

suiteHealthRouter.use(requireAuth);

/**
 * How many tests one request will read. This is a memory guard — the analysis
 * needs every test's `code` in hand at once — not an opinion about suite size.
 *
 * Hitting it does NOT silently produce a score over a sample. `limits.partial`
 * goes true and `limits.note` says what was left out, because a health score
 * computed over an unstated subset is worse than no score: it is a number that
 * looks authoritative and is not. On the snapshot path the same cap lands in
 * `caveats` as a sentence carrying the shortfall — see {@link caveatsFrom}.
 */
const MAX_TESTS = 2000;

/** Page size for the trend read. The cap is reported, never applied in silence. */
const HISTORY_CAPS = {
  pageDefault: 50,
  pageMax: 200,
} as const;

/**
 * The scope sentence, as one string used in three places: the live read's
 * `limits.scope`, the stored snapshot's fingerprint, and the history
 * response. A snapshot measured over a different candidate set is not
 * comparable with one measured over this set, so the scope is an INPUT to the
 * fingerprint rather than prose beside it.
 */
const SCOPE = 'enabled, non-fixture tests; quarantined tests included';

/**
 * Bumped BY HAND whenever a change to `packages/agent/src/suite-health.ts` or
 * to the mapping in {@link snapshotDataFrom} could move a number from the same
 * inputs.
 *
 * It is a belt to the fingerprint's braces rather than the mechanism: the
 * fingerprint also hashes the computed measurements (see {@link fingerprintOf}),
 * so an analyser change that moves a number is detected whether or not anybody
 * remembered this constant. What the constant buys is the case the measurements
 * cannot cover — an analyser change that alters the MEANING of an unchanged
 * number, which no hash of the outputs can see.
 */
const FINGERPRINT_VERSION = 'shsnap1';

const querySchema = z.object({
  /**
   * Pairs scoring below this are not reported. Lowering it surfaces looser
   * overlaps and costs precision; the default is the module's own.
   */
  minSimilarity: z.coerce.number().min(0).max(1).optional(),
  maxReportedPairs: z.coerce.number().int().min(1).max(500).optional(),
});

type HealthQuery = z.infer<typeof querySchema>;

/**
 * Tenancy is enforced by the Prisma extension, so a project belonging to
 * another org reads as absent — which is exactly the behaviour notFound()
 * exists to give. CROSS-TENANT IS A 404 AND NEVER A 403: a 403 would confirm
 * the project exists, and this endpoint must not become an existence oracle.
 */
async function projectOr404(
  projectId: string,
): Promise<{ id: string; orgId: string; name: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    // `orgId` is selected because the snapshot write needs it: the tenancy
    // extension stamps it at run time, but `SuiteHealthSnapshotCreateInput`
    // requires it at the type level, and the house pattern (see
    // routes/api-surface.ts) passes the project's own rather than trusting the
    // ambient scope to be the one it meant.
    select: { id: true, orgId: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

/**
 * The same shape as `parseList` in routes/surface.ts and routes/api-surface.ts,
 * and copied rather than shared for the reason given there: the three live in
 * different routers with different vocabularies, and a shared one would need a
 * home none of them owns.
 *
 * AN UNKNOWN VALUE IS A 400 THAT NAMES THE VALID ONES. `?source=ERROR`
 * answering `[]` would read as "no snapshot was taken that way", which is a
 * claim about the customer's history manufactured out of a typo.
 */
function parseList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  field: string,
): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const bad = parts.filter((part) => !allowed.includes(part as T));
  if (bad.length > 0) {
    throw badRequest(
      `Unknown ${field}: ${bad.join(', ')}. Valid values are ${allowed.join(', ')}.`,
    );
  }
  return parts as T[];
}

// ─── The one producer ────────────────────────────────────────────────────────

/** Columns the analysis reads. Named once so the select cannot drift from it. */
const TEST_SELECT = {
  id: true,
  name: true,
  filePath: true,
  type: true,
  priority: true,
  feature: true,
  tags: true,
  code: true,
  spec: true,
  flakeRate: true,
  quarantined: true,
  consecutiveFailures: true,
} as const;

interface ComputedHealth {
  report: SuiteHealthReport;
  tests: SuiteHealthTestInput[];
  /** Runnable tests matching the scope, counted WITHOUT the cap applied. */
  testsMatching: number;
  flowMapVersion: number | null;
  options: HealthQuery;
}

/**
 * ONE producer of the reading, called by the live read and by the writer.
 *
 * Factored out of the GET handler and not re-implemented beside it. A second
 * copy of this would be a second answer: the stored trend and the dashboard
 * would drift apart on the first change to either, and the trend is only worth
 * anything if the point it stores is the number the customer was shown.
 */
async function computeSuiteHealth(
  projectId: string,
  options: HealthQuery,
): Promise<ComputedHealth> {
  /*
   * The same candidate set POST /runs builds: enabled, non-fixture tests.
   * Disabled rows and `fixtures/` helpers are not tests you can run, and
   * grading the suite on rows that never execute would mean a team could raise
   * its score by disabling the tests that were failing.
   *
   * Quarantined tests are deliberately kept IN. A quarantine is a signal
   * switched off, not a test that stopped existing, and it has to cost the
   * score something — see the `quarantine` component.
   */
  const where = {
    projectId,
    disabledAt: null,
    filePath: { not: { startsWith: FIXTURE_PREFIX } },
  } as const;

  const [tests, testsMatching] = await Promise.all([
    prisma.test.findMany({
      where,
      // Deterministic: two calls a second apart must analyse the same rows, or
      // the score moves for reasons nobody can trace back to a code change.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_TESTS,
      select: TEST_SELECT,
    }),
    prisma.test.count({ where }),
  ]);

  /*
   * Latest crawl only. Older versions describe an app that no longer exists,
   * and stale journeys would report critical-path coverage against routes the
   * product has since moved. No flow map at all is fine: the coverage
   * component reports itself unmeasured and its weight is redistributed.
   */
  const flowMap = await prisma.flowMap.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
    select: { graph: true, version: true },
  });

  const report = analyzeSuiteHealth({
    // No cast: the selected columns already satisfy SuiteHealthTestInput, and
    // `spec` is declared `unknown` there precisely so a Prisma JsonValue drops
    // straight in. If this ever stops compiling, the select drifted from the
    // analysis input — which is the compile error you want, not one to silence.
    tests,
    flowMapGraph: flowMap?.graph ?? null,
    // Absent query params arrive as undefined and the analysis falls back to
    // its own defaults, so there is nothing to branch on here.
    options: {
      minSimilarity: options.minSimilarity,
      maxReportedPairs: options.maxReportedPairs,
    },
  });

  return {
    report,
    tests,
    testsMatching,
    flowMapVersion: flowMap?.version ?? null,
    options,
  };
}

// ─── Reading → snapshot ──────────────────────────────────────────────────────

/**
 * One measurement, or NULL, taken from the component that produced it.
 *
 * The component's own `available` flag is the PRODUCER'S judgement about
 * whether its number is a measurement, and it is honoured here rather than
 * second-guessed. `duplication` in particular sets `available: false` when the
 * near-duplicate scan was capped, because a shorter duplicate list would RAISE
 * that component's score — so a capped scan stores NULL and never a flattering
 * count.
 *
 * A missing or non-integral evidence key is also NULL, which is the one way
 * this can go quiet: rename `evidence.quarantined` in suite-health.ts and this
 * column silently stops being written. `records the evidence keys it reads`
 * in suite-health.test.ts pins every key against a real fixture for exactly
 * that reason, so the rename goes red here instead of going NULL in production.
 */
function measuredCount(component: HealthComponent | undefined, key: string): number | null {
  if (!component || !component.available) return null;
  const raw = component.evidence[key];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
  return raw;
}

/** The evidence key each stored count is read out of, named once. */
const COUNT_SOURCES = {
  quarantinedCount: ['quarantine', 'quarantined'],
  flakyCount: ['flakiness', 'testsAtOrAbove5Percent'],
  weakAssertionCount: ['assertionStrength', 'testsWithFindings'],
  duplicateCount: ['duplication', 'duplicatedTests'],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * The ten stored measurements, and NULL for every one this scan did not make.
 *
 * ── WHAT THIS SCAN GENUINELY PRODUCES, AND WHAT IT DOES NOT ─────────────────
 *
 * Four counts come from the components above. `testCount` is the rows this scan
 * considered. The other five are NULL FROM THIS DOOR, ALWAYS, and each for a
 * stated reason rather than an omission:
 *
 *   · `passRatePercent`, `medianDurationMs`, `p95DurationMs` — this is a
 *     SOURCE-ONLY scan. It reads test source and never a result row, so it has
 *     no pass rate and no durations, and `runId` is NULL beside them. 0 here
 *     would be a suite that fails every test and finishes instantly. A
 *     run-backed writer that fills these three and sets `runId` does not exist;
 *     that is an open problem, not a column to default.
 *   · `obsoleteCount` — `analyzeSuiteHealth` has NO obsolete-test measurement
 *     at all. Nothing in this repo computes it. Writing 0 would be the best
 *     possible result ("no test asserts against surface that is gone")
 *     manufactured out of a missing analyser.
 *   · `score` — `report.score` is a real composite EXCEPT when no component was
 *     available, where the analyser returns 0 and says so in its own
 *     `formula`: "the score is 0 by default, not by evidence". That 0 is the
 *     exact lie this column's doc comment forbids, so it is stored as NULL.
 *
 * Nothing here computes a new measurement to fill a column.
 */
function snapshotDataFrom(computed: ComputedHealth): SuiteHealthSnapshotData {
  const byKey = new Map(computed.report.components.map((c) => [c.key, c]));
  const count = (field: keyof typeof COUNT_SOURCES): number | null => {
    const [componentKey, evidenceKey] = COUNT_SOURCES[field];
    return measuredCount(byKey.get(componentKey), evidenceKey);
  };

  /*
   * `availableWeight === 0` in `scoreSuiteHealth` iff no component is
   * available — every nominal weight is positive — and that is the branch whose
   * score is 0 by default rather than by evidence.
   */
  const anythingScored = computed.report.components.some((component) => component.available);

  return {
    /*
     * The rows this scan CONSIDERED, which is a complete measurement of the
     * scanned set even when the cap bit. It is deliberately not NULL in that
     * case: NULL would throw away the one number the scan definitely made. The
     * shortfall is disclosed as a caveat instead, so a trend that flat-lines at
     * MAX_TESTS reads as "capped" and not as "the suite stopped growing".
     */
    testCount: computed.report.totals.tests,
    quarantinedCount: count('quarantinedCount'),
    flakyCount: count('flakyCount'),
    weakAssertionCount: count('weakAssertionCount'),
    duplicateCount: count('duplicateCount'),
    obsoleteCount: null,
    passRatePercent: null,
    medianDurationMs: null,
    p95DurationMs: null,
    score: anythingScored ? computed.report.score : null,
  };
}

/**
 * Cut a string to `max`, SAYING SO when it cuts.
 *
 * A caveat is the one field on the row whose job is to disclose truncation, so
 * a caveat truncated in silence would be the defect wearing its own uniform.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = ' (reason truncated)';
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/**
 * Every cap that BIT and every thing the scan could not read, as sentences.
 *
 * ── WHAT BELONGS HERE AND WHAT DOES NOT ─────────────────────────────────────
 *
 * TRUNCATION AND UNREADABILITY ONLY: a scan budget, a take, a parse that
 * failed. That boundary is what keeps an EMPTY list meaningful — an empty
 * `caveats` is a positive claim that nothing was truncated and everything
 * parsed, which is verifiable, and it is the only defaulted column on the table
 * for exactly that reason.
 *
 * So a component being UNMEASURED is not a caveat: a project with no flow map
 * has not had anything truncated, and that fact is already visible as the NULL
 * column it produced and in the live read's `limits.flowMapVersion`. Putting it
 * here would mean no project without a crawl could ever have an empty caveat
 * list, and the list would stop meaning "nothing was cut".
 *
 * NO CUSTOMER SOURCE TEXT IS INTERPOLATED. `limits.skippedCommonTokens` holds
 * tokens read out of the customer's test files, and a stored caveat is a string
 * that lands in a response and a log; the COUNT is the fact a reader needs, so
 * the count is what is written.
 */
function caveatsFrom(computed: ComputedHealth): string[] {
  const caveats: string[] = [];
  const { report, tests, testsMatching } = computed;

  if (testsMatching > tests.length) {
    const omitted = testsMatching - tests.length;
    caveats.push(
      `The ${MAX_TESTS}-test scan cap bit: the oldest ${tests.length} of ${testsMatching} runnable tests were scanned, so at least ${omitted} more existed and are in none of these numbers.`,
    );
  }

  if (report.totals.unanalyzed > 0) {
    caveats.push(
      `${report.totals.unanalyzed} of ${report.totals.tests} scanned test(s) could not be read end to end, so they are excluded from the assertion-strength and duplication denominators. The live read names them in \`unanalyzed\`.`,
    );
  }

  if (!report.limits.duplicateScanComplete) {
    caveats.push(
      clip(
        `The near-duplicate scan did not complete, so duplicateCount is NULL rather than a short count that would read as a cleaner suite. Reason: ${report.limits.duplicateScanNote ?? 'not stated by the analyser'}`,
        500,
      ),
    );
  }

  if (report.limits.omittedPairs > 0) {
    caveats.push(
      `${report.limits.omittedPairs} near-duplicate pair(s) scored above the ${report.limits.minSimilarity} similarity threshold and were omitted from the reported pair list by its cap. duplicateCount counts cluster members and is unaffected.`,
    );
  }

  if (report.limits.omittedClusters > 0) {
    caveats.push(
      `${report.limits.omittedClusters} near-duplicate cluster(s) exist beyond the payload cap on the reported list. duplicateCount counts the members of EVERY cluster, so the number is complete and only the list is short.`,
    );
  }

  if (report.limits.findingsCapped) {
    caveats.push(
      `The weak-assertion scan stopped at its findings cap, so weakAssertionCount is a LOWER BOUND: at least that many tests carry a weakness and more may exist.`,
    );
  }

  if (report.limits.skippedCommonTokens.length > 0) {
    caveats.push(
      `${report.limits.skippedCommonTokens.length} token(s) were too common across the suite to index and were skipped by the duplicate scan, so two tests that overlap only on those tokens were not compared. The tokens are the customer's own source text and are named in the live read, not stored here.`,
    );
  }

  return caveats;
}

/**
 * JSON with keys in a fixed order, at every depth.
 *
 * `JSON.stringify` preserves insertion order, so the same `spec` blob read back
 * in a different key order would hash differently and mint a new snapshot for
 * an unchanged suite. The fingerprint has to be a function of the VALUE.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Changes whenever the answer could change — the column's own contract.
 *
 * ── WHAT IS IN IT ───────────────────────────────────────────────────────────
 *
 *  1. {@link FINGERPRINT_VERSION}, {@link SCOPE} and {@link MAX_TESTS}: a
 *     reading taken over a different candidate set or a different cap is not
 *     the same reading.
 *  2. The project id, and the two query options that change what the analyser
 *     reports (`minSimilarity`, `maxReportedPairs`).
 *  3. The flow map version, which decides whether critical-path coverage is
 *     measurable at all.
 *  4. `testsMatching` — so a suite that GREW past the cap gets a new
 *     fingerprint even though the scanned 2000 rows are byte-identical.
 *
 *     THIS ONE IS DELIBERATELY REDUNDANT TODAY, and the redundancy is worth
 *     knowing about: removing it changes no behaviour, because the cap's caveat
 *     sentence quotes both totals and (6) hashes the caveats, and when the cap
 *     does NOT bite `testsMatching` equals the row count that (5) already
 *     covers. It stays because that coupling runs through PROSE — reword the
 *     caveat to drop the total and the fingerprint would quietly stop noticing
 *     a growing suite. Mutation-tested: deleting this line kills no test, which
 *     is the reason the note is here rather than in a report nobody reads.
 *  5. EVERY INPUT ROW the analyser read, hashed per test and SORTED BY ID, so
 *     the fingerprint is a function of the set and not of the page order.
 *  6. The ten computed measurements and the caveats.
 *
 * (6) is what makes "an unchanged score and an unchanged measurement
 * distinguishable" strict in both directions. Inputs alone would miss an
 * analyser change that moved a number from identical rows; outputs alone would
 * collapse two genuinely different suites that happen to score the same, and
 * then the trend would hide a suite being rewritten under it.
 *
 * NO CLOCK AND NO RANDOM. Two scans of an unchanged suite a week apart produce
 * the same fingerprint, which is the whole basis of the de-duplication in
 * {@link writeSnapshot}.
 */
function fingerprintOf(
  projectId: string,
  computed: ComputedHealth,
  data: SuiteHealthSnapshotData,
  caveats: readonly string[],
): string {
  const rows = computed.tests
    .map((test) =>
      [
        test.id,
        test.name,
        test.filePath,
        test.type,
        test.priority,
        test.feature ?? '',
        [...test.tags].sort().join(','),
        String(test.flakeRate),
        String(test.quarantined),
        String(test.consecutiveFailures),
        // Hashed, not carried: the source is the customer's and never needs to
        // exist in memory as one concatenated string the length of their suite.
        sha256(test.code ?? ''),
        sha256(canonicalJson(test.spec ?? null)),
      ].join('\u0000'),
    )
    .sort();

  const material = [
    FINGERPRINT_VERSION,
    projectId,
    SCOPE,
    String(MAX_TESTS),
    String(computed.testsMatching),
    String(computed.flowMapVersion ?? ''),
    String(computed.options.minSimilarity ?? ''),
    String(computed.options.maxReportedPairs ?? ''),
    canonicalJson(data),
    canonicalJson(caveats),
    ...rows,
  ].join('\u001e');

  return `${FINGERPRINT_VERSION}:${sha256(material)}`;
}

// ─── The stored row → the response ───────────────────────────────────────────

const SNAPSHOT_SELECT = {
  id: true,
  projectId: true,
  createdAt: true,
  commitSha: true,
  runId: true,
  testCount: true,
  quarantinedCount: true,
  flakyCount: true,
  weakAssertionCount: true,
  duplicateCount: true,
  obsoleteCount: true,
  passRatePercent: true,
  medianDurationMs: true,
  p95DurationMs: true,
  score: true,
  caveats: true,
  fingerprint: true,
} as const;

type SnapshotRow = Prisma.SuiteHealthSnapshotGetPayload<{ select: typeof SNAPSHOT_SELECT }>;

/**
 * Read the stored caveats back as sentences.
 *
 * A stored value that is not an array of strings is a writer bug, and the one
 * thing this must not do about it is answer `[]` — that is the positive claim
 * that nothing was truncated, which would be manufactured out of our own failed
 * parse. So an unreadable list becomes a caveat saying exactly that.
 */
function caveatsOf(row: SnapshotRow): string[] {
  const stored: Prisma.JsonValue = row.caveats;
  // An explicit predicate rather than a cast afterwards: the narrowing is the
  // check, so there is nothing left to assert.
  if (
    Array.isArray(stored) &&
    stored.every((entry): entry is string => typeof entry === 'string')
  ) {
    return stored;
  }
  return [
    'The stored caveat list could not be read as sentences, so it is reported as unreadable rather than as empty — an empty list would claim nothing was truncated.',
  ];
}

/** The shared view of a stored reading. A NULL measurement STAYS NULL. */
function snapshotView(row: SnapshotRow): SuiteHealthSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    createdAtIso: row.createdAt.toISOString(),
    commitSha: row.commitSha,
    runId: row.runId,
    data: {
      testCount: row.testCount,
      quarantinedCount: row.quarantinedCount,
      flakyCount: row.flakyCount,
      weakAssertionCount: row.weakAssertionCount,
      duplicateCount: row.duplicateCount,
      obsoleteCount: row.obsoleteCount,
      passRatePercent: row.passRatePercent,
      medianDurationMs: row.medianDurationMs,
      p95DurationMs: row.p95DurationMs,
      score: row.score,
    },
    caveats: caveatsOf(row),
    fingerprint: row.fingerprint,
  };
}

// ─── GET /suite-health/:projectId ────────────────────────────────────────────

suiteHealthRouter.get('/:projectId', requireScope('tests:read'), async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }

  const project = await projectOr404(String(req.params.projectId));
  const computed = await computeSuiteHealth(project.id, parsed.data);
  const { report, tests, testsMatching } = computed;
  const partial = testsMatching > tests.length;

  res.json({
    projectId: project.id,
    score: report.score,
    grade: report.grade,
    components: report.components,
    formula: report.formula,
    duplicates: report.duplicates,
    duplicateClusters: report.duplicateClusters,
    weakAssertions: report.weakAssertions,
    criticalPaths: report.criticalPaths,
    totals: report.totals,
    /**
     * Named, not counted. "3 tests were skipped" tells the reader nothing they
     * can act on; the test that could not be parsed is the one they need to
     * open, and a suite-health report that quietly drops rows is exactly the
     * kind of reporting problem this codebase has been bitten by before.
     */
    unanalyzed: report.unanalyzed,
    limits: {
      ...report.limits,
      /** True when the score covers only part of the suite. Read it first. */
      partial,
      maxTests: MAX_TESTS,
      testsAnalyzed: tests.length,
      testsMatching,
      note: partial
        ? `This project has ${testsMatching} runnable tests and this report covers the oldest ${tests.length}. The score describes that subset, not the suite.`
        : null,
      /**
       * Surfaced because it changes how much to trust critical-path coverage:
       * with no flow map there are no journeys to measure against, and that
       * component reports itself unmeasured rather than guessing.
       */
      flowMapVersion: computed.flowMapVersion,
      /** Disabled tests and `fixtures/` rows are out of scope by construction. */
      scope: SCOPE,
    },
  });
});

// ─── POST /suite-health/:projectId/snapshots ─────────────────────────────────

const snapshotBodySchema = z
  .object({
    /**
     * The commit the scan was taken against, when the caller knows it. Bounded
     * at the schema's own 7..64 — the stored column is indexed with `projectId`
     * for the per-commit trend, and a caller-supplied string that lands in an
     * index is bounded rather than trusted.
     */
    commitSha: z.string().trim().min(7).max(64).nullable().optional(),
    minSimilarity: z.number().min(0).max(1).optional(),
    maxReportedPairs: z.number().int().min(1).max(500).optional(),
  })
  /*
   * `.strict()`, and `runId` is the field it exists to refuse.
   *
   * This door takes a SOURCE-ONLY scan, so `runId` is NULL and the pass-rate
   * and duration columns are NULL beside it. A body carrying a runId that was
   * accepted-and-ignored would store a row claiming those three numbers came
   * from that run, which is the model's doc comment made false by its own
   * writer. A 400 naming the field is the honest answer until a run-backed
   * writer exists.
   */
  .strict();

/**
 * Store the reading, so rot has a direction.
 *
 * ── A REPEAT SCAN WITH AN IDENTICAL FINGERPRINT DOES NOT WRITE A ROW ────────
 *
 * It answers 200 with the row already there and `created: false`. Both answers
 * are defensible and this is the one chosen, for a reason about the chart rather
 * than about storage: the fingerprint covers every input AND every output that
 * could move a number, so an identical fingerprint means the answer could not
 * have changed, and a second point carrying no new information is noise an
 * hourly schedule would turn into a wall of it. More than that, the kept row's
 * `createdAt` is the FIRST time this answer was observed, which is the honest
 * timestamp for "how long has it been like this?" — re-stamping it would erase
 * the length of a plateau, and the length of a plateau is most of what a rot
 * chart is for.
 *
 * THE RACE IS REAL AND IS NOT HIDDEN. The schema has no unique index on
 * (projectId, fingerprint) — this work may not add one — so two scans racing
 * can both miss and both insert. The consequence is bounded and visible: two
 * rows with the same fingerprint and different `createdAt`, which the history
 * read returns as two points a reader can see are identical. It is not
 * papered over with a transaction, because an interactive transaction around a
 * findFirst/create does not prevent it either and would only make the code look
 * as though it did.
 */
suiteHealthRouter.post(
  '/:projectId/snapshots',
  requireRole('MEMBER'),
  requireScope('tests:write'),
  async (req, res) => {
    const parsed = snapshotBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body', {
        fieldErrors: parsed.error.flatten().fieldErrors,
      });
    }
    const body = parsed.data;
    const actor = actorOf(req);
    const project = await projectOr404(String(req.params.projectId));

    const computed = await computeSuiteHealth(project.id, {
      minSimilarity: body.minSimilarity,
      maxReportedPairs: body.maxReportedPairs,
    });

    const data = snapshotDataFrom(computed);
    const caveats = caveatsFrom(computed);
    const fingerprint = fingerprintOf(project.id, computed, data, caveats);

    /*
     * Parsed through the shared schema and not assembled straight into the
     * create. Every number on it is `.nullable()` with a null default and no
     * `.default(0)` anywhere, so this parse is the guard that a mapping bug
     * which produced a 0 for an unmeasured column cannot become a row: a value
     * out of range (a negative count, a percent over 100) is rejected here
     * rather than stored and believed.
     */
    const validated = suiteHealthSnapshotSchema.safeParse({
      ...data,
      commitSha: body.commitSha ?? null,
      /** Source-only. See `.strict()` on the body schema. */
      runId: null,
      caveats,
      fingerprint,
    });
    if (!validated.success) {
      throw badRequest('The computed snapshot is not storable', {
        fieldErrors: validated.error.flatten().fieldErrors,
      });
    }
    const row = validated.data;

    const existing = await prisma.suiteHealthSnapshot.findFirst({
      where: { projectId: project.id, fingerprint: row.fingerprint },
      orderBy: { createdAt: 'asc' },
      select: SNAPSHOT_SELECT,
    });

    if (existing) {
      /*
       * Audited even though nothing was written. "A scan ran and produced the
       * answer already on file" is a different fact from "no scan ran", and the
       * audit log is the only place the difference is recorded.
       */
      await audit({
        actor,
        action: 'suiteHealth.snapshot',
        targetType: 'SuiteHealthSnapshot',
        targetId: existing.id,
        metadata: {
          projectId: project.id,
          created: false,
          fingerprint: row.fingerprint,
          caveats: caveats.length,
        },
      });
      res.status(200).json({
        projectId: project.id,
        created: false,
        reason:
          'A snapshot with this fingerprint is already stored, so the answer could not have changed and no new point was added. `createdAt` is when this answer was FIRST observed.',
        snapshot: snapshotView(existing),
      });
      return;
    }

    const created = await prisma.suiteHealthSnapshot.create({
      data: {
        orgId: project.orgId,
        projectId: project.id,
        commitSha: row.commitSha,
        runId: row.runId,
        testCount: row.testCount,
        quarantinedCount: row.quarantinedCount,
        flakyCount: row.flakyCount,
        weakAssertionCount: row.weakAssertionCount,
        duplicateCount: row.duplicateCount,
        obsoleteCount: row.obsoleteCount,
        passRatePercent: row.passRatePercent,
        medianDurationMs: row.medianDurationMs,
        p95DurationMs: row.p95DurationMs,
        score: row.score,
        caveats: row.caveats,
        fingerprint: row.fingerprint,
      },
      select: SNAPSHOT_SELECT,
    });

    await audit({
      actor,
      action: 'suiteHealth.snapshot',
      targetType: 'SuiteHealthSnapshot',
      targetId: created.id,
      metadata: {
        projectId: project.id,
        created: true,
        fingerprint: row.fingerprint,
        /*
         * The COUNT of caveats, not the sentences. They are our own prose
         * today, but one of them reports a parse failure over the customer's
         * test source and the audit log is not where that belongs.
         */
        caveats: caveats.length,
        testsScanned: computed.tests.length,
        testsMatching: computed.testsMatching,
      },
    });

    res.status(201).json({
      projectId: project.id,
      created: true,
      /**
       * Which columns this door never fills, said out loud beside the row.
       * A reader charting `passRatePercent` from a source-only scan is charting
       * nothing, and the NULLs alone do not say whether that is "not yet
       * measured" or "never measurable from here".
       */
      unmeasured: {
        passRatePercent: 'source-only scan: no run was read, so there is no pass rate',
        medianDurationMs: 'source-only scan: no run was read, so there are no durations',
        p95DurationMs: 'source-only scan: no run was read, so there are no durations',
        obsoleteCount:
          'nothing in this product measures obsolete tests yet; 0 would be the best possible result claimed from a missing analyser',
        ...(row.score === null
          ? {
              score:
                'no component of the health score could be measured, and the analyser returns 0 for that by default rather than by evidence',
            }
          : {}),
      },
      snapshot: snapshotView(created),
    });
  },
);

// ─── GET /suite-health/:projectId/history ────────────────────────────────────

/** Whether a reading's pass-rate and duration halves came from a run. */
const SNAPSHOT_SOURCES = ['RUN', 'SOURCE_ONLY'] as const;
type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_CAPS.pageMax).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  /** The per-commit trend. `@@index([projectId, commitSha])` exists for it. */
  commitSha: z.string().trim().min(7).max(64).optional(),
  /** Comma-separated; validated by `parseList`, which names the valid values. */
  source: z.string().trim().min(1).max(100).optional(),
});

/**
 * The trend, newest first — the only reason the table exists.
 *
 * `@@index([projectId, createdAt])` is what this read is for. A NULL
 * measurement comes back null; nothing is coalesced on the way out, because the
 * entire value of a stored reading is that "we did not measure it" survived
 * being written down.
 */
suiteHealthRouter.get('/:projectId/history', requireScope('tests:read'), async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query', {
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
  }
  const query = parsed.data;
  const sources = parseList<SnapshotSource>(query.source, SNAPSHOT_SOURCES, 'source');
  const project = await projectOr404(String(req.params.projectId));

  /*
   * THE FILTERS ARE IN THE QUERY AND THE CAP IS THE `take` AFTER THEM, and
   * `total` is counted under the same filters. A cap applied first would page
   * 50 arbitrary snapshots and then filter them, so a page could come back
   * empty while a hundred matching readings existed — an empty answer
   * manufactured by our own pagination, which for a trend reads as "this suite
   * has never been measured".
   */
  const where: Prisma.SuiteHealthSnapshotWhereInput = { projectId: project.id };
  if (query.commitSha !== undefined) where.commitSha = query.commitSha;
  if (sources !== undefined && sources.length === 1) {
    where.runId = sources[0] === 'RUN' ? { not: null } : null;
  }

  const limit = query.limit ?? HISTORY_CAPS.pageDefault;
  const offset = query.offset ?? 0;
  const [rows, total] = await Promise.all([
    prisma.suiteHealthSnapshot.findMany({
      where,
      // Newest first. The id is a stable tiebreak for two readings that share a
      // `createdAt` — which the fingerprint race above can genuinely produce.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      select: SNAPSHOT_SELECT,
    }),
    prisma.suiteHealthSnapshot.count({ where }),
  ]);

  const truncated = offset + rows.length < total;

  res.json({
    projectId: project.id,
    snapshots: rows.map(snapshotView),
    total,
    offset,
    limit,
    /** The cap as a COUNT and as a REASON, both, whenever it bit. */
    truncated,
    truncatedBy: truncated ? total - (offset + rows.length) : 0,
    truncatedReason: truncated
      ? `At least ${total - (offset + rows.length)} more snapshot(s) match these filters and are not on this page; the page size is ${limit} (max ${HISTORY_CAPS.pageMax}). Page on with \`offset\`.`
      : null,
    filters: {
      commitSha: query.commitSha ?? null,
      source: sources ?? null,
      note: 'filters are applied in the query and `total` is counted under the same filters, so a short page means the list is exhausted and never that the filter ran after the cap. `source=RUN,SOURCE_ONLY` names both and therefore filters nothing.',
    },
    caps: HISTORY_CAPS,
    rule:
      'A NULL measurement means it was not measured and is never a 0. The three run-backed ' +
      'columns (passRatePercent, medianDurationMs, p95DurationMs) are NULL on every ' +
      'source-only reading, beside a NULL runId; obsoleteCount is NULL on all of them because ' +
      'nothing measures it yet. An empty `caveats` is a positive claim that nothing was ' +
      'truncated and everything parsed.',
    scope: SCOPE,
  });
});

/**
 * The behaviour the analysis extracted from one test, and nothing else.
 *
 * "Why is this called a duplicate of that?" and "why is my strong test flagged
 * weak?" both have the same answer — the routes, actions and assertions we
 * read out of it — and that answer has to be inspectable BEFORE somebody acts
 * on a finding, not after they have argued with it. Everything here is derived
 * from the row the caller already owns; nothing new is disclosed.
 */
suiteHealthRouter.get('/:projectId/tests/:testId', requireScope('tests:read'), async (req, res) => {
  const project = await projectOr404(String(req.params.projectId));

  const test = await prisma.test.findFirst({
    where: { id: String(req.params.testId), projectId: project.id },
    select: TEST_SELECT,
  });
  if (!test) throw notFound('Test');

  // The same extractor the project report runs, so what is shown here cannot
  // drift from what the score was computed from.
  const behavior = extractBehavior(test);
  const report = analyzeSuiteHealth({ tests: [test] });

  res.json({
    testId: test.id,
    name: test.name,
    /** The comparison keys. Two tests are duplicates iff these agree. */
    behavior: {
      routes: behavior.routes,
      actions: behavior.actions,
      assertions: behavior.assertions,
      data: behavior.data,
      assertionSites: behavior.assertionSites,
    },
    /**
     * NO_NEGATIVE_PATH is absent by construction, not by omission. It is a
     * judgement about a whole feature — "nothing here exercises an error path"
     * — and one test taken alone cannot support it. Reporting it from a
     * single-test view would accuse a test whose sibling already covers the
     * error case. Ask the project report for it.
     */
    weakAssertions: report.weakAssertions.filter((f) => f.kind !== 'NO_NEGATIVE_PATH'),
    incomplete: behavior.incomplete,
    incompleteReason: behavior.incompleteReason,
  });
});
