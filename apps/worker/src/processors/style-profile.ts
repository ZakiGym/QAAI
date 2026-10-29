/**
 * COMPUTE AND STORE THIS PROJECT'S HOUSE STYLE.
 *
 * `Project.styleProfile` and `Project.styleProfileComputedAt` have existed for
 * three rounds. `processGenerate` SELECTs both of them, `readStyleProfile`
 * validates them, `styleProfileBriefing` renders them and `houseStyleFlags`
 * apologises when they are absent — and NOTHING IN apps/ EVER WROTE EITHER. So
 * every generate job read NULL, the briefing honestly rendered "not
 * established", `selectExemplars` reported 0 of 0, and "no existing test is
 * ever shown to the model" stayed true on the only path that runs. This file is
 * the writer.
 *
 * ── WHY A JOB OF ITS OWN, ARGUED FROM COST AND STALENESS ───────────────────
 *
 * Three places could have computed it. Two are wrong and the reasons are not
 * about convenience:
 *
 *   LAZILY, ON THE FIRST GENERATE. The computation needs the repository's test
 *   FILES, which means a materialised checkout — a repository archive download,
 *   bounded at `MAX_ARCHIVE_BYTES` (128MB) and extracted under
 *   `MAX_WORKSPACE_BYTES` (512MB). `processGenerate` refuses to materialise one
 *   and says so at length, for the right reason: a generate batch is a person
 *   waiting on a plan they just approved, and putting a tarball download in
 *   front of it taxes every batch for a measurement whose answer moves monthly.
 *   Worse, it would couple generation to the GitHub App being installed: a
 *   project with no connected repository would pay a failed download per batch.
 *
 *   AS A STEP OF THE ENUMERATE PASS. A crawl drives a browser against a base
 *   URL. It never puts a line of the customer's code on disk and has no
 *   repository to read, so the profile's freshness would become a function of
 *   whether anybody had crawled — two unrelated measurements sharing one
 *   trigger, where the cheap one (the crawl) is also the one that runs for
 *   projects whose repository QAAI cannot reach at all.
 *
 *   A DEDICATED JOB, which is what this is. The cost is paid ONCE PER PROJECT
 *   PER FRESHNESS WINDOW rather than per batch or per crawl, the coalescing job
 *   id makes a burst of triggers one download, and the absence is already
 *   honest downstream — no profile means `houseStyleFlags` says so on every
 *   test it writes. It is DEMAND-DRIVEN and there is deliberately no repeatable
 *   sweep: a timer would download a repository per project for projects nobody
 *   is writing tests for, which is a cost with no reader.
 *
 * ── WHAT "STALE" MEANS HERE, AND WHY NOT ANOTHER DEFINITION ────────────────
 *
 * Stale is `now - styleProfileComputedAt >= STYLE_PROFILE_FRESH_MS`, or the two
 * columns disagreeing about whether there is a profile at all. See
 * {@link STYLE_PROFILE_FRESH_MS} for why a week and not a day or a quarter.
 *
 * THE DEFINITION I WANTED AND CANNOT HAVE is "the default branch head moved
 * since the profile was computed", which is the only definition that is exactly
 * right. It needs a commit sha stored beside the profile, there is no column for
 * one, this change does not own `schema.prisma`, and asking GitHub for the head
 * on the READ path would put a network call inside `processGenerate`. The exact
 * column is in the handover; until it exists the date is the whole signal, which
 * is why `styleProfileComputedAt` is a column rather than a field inside the
 * blob — its own schema comment says so: "staleness is answerable in SQL".
 *
 * ── A STORED PROFILE CARRIES NO VERSION, AND IS RE-VALIDATED ON READ ───────
 *
 * `directoryForRole` was fixed to re-ask `destinationDecision` on BOTH of its
 * evidence branches precisely because a `styleProfile` computed before that
 * guard existed is still in the database and a profile is not re-derived on
 * read. The obvious response is to stamp a version on what this writer stores.
 * It is the wrong response, for three reasons:
 *
 *   · `styleProfileSchema` is `.strict()`. A `version` key cannot be added
 *     without editing packages/shared/src/schemas.ts AND rewriting every row
 *     already stored, and this change owns neither.
 *   · A VERSION SAYS A PROFILE IS OLD; IT DOES NOT SAY WHICH FIELD IS UNSAFE.
 *     The thing that decides that — `destinationDecision` over
 *     `fileLayout.root` — is a pure function of the stored value and can simply
 *     be asked again. Asking again is correct for a row written yesterday by a
 *     producer with a bug, which a version number would vouch for.
 *   · An unmigrated version is indistinguishable from a producer that forgot to
 *     set one, so it would have to be treated as absent anyway — a decoration
 *     printed beside a value that is re-validated regardless.
 *
 * What the WRITER owes instead, and does: it pushes every profile through
 * `styleProfileSchema` — the validator the read path runs — BEFORE storing it,
 * so a reader's parse failure means tampering or a schema change and never a
 * producer bug; and it writes the blob and the date in ONE `update`, so the
 * pair `readStyleProfile` cross-checks can never disagree because of a partial
 * write.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * IT NEVER STORES A PROFILE IT COULD NOT COMPUTE. A repository QAAI cannot
 * reach produces {@link StyleProfileOutcome} `UNAVAILABLE` and writes NOTHING,
 * because `emptyStyleProfile` stored in that column is a profile that
 * confidently reports no conventions — a different and false claim, as the
 * column's own schema comment says. NULL means "nobody has measured this"; a
 * stored all-UNKNOWN profile means "we read your tests and found no
 * convention", and only an actual scan of nothing may write the second.
 *
 * Every byte this reads is UNTRUSTED CUSTOMER SOURCE and `learnStyle` is where
 * that rule is enforced; this file hands it a filesystem and stores what comes
 * back. Nothing read here decides a path, a command, a git ref or a gate: the
 * only ref that reaches GitHub is `Project.defaultBranch` through
 * `materialiseRepoWorkspace`'s own `safeRef`, and the only paths opened are
 * ones `destinationDecision` admitted and `nodeWorkspaceFileReader` re-`lstat`ed
 * segment by segment.
 */

import { Queue } from 'bullmq';
import { learnStyle, type LearnedStyle, type TestFileSource } from '@qaai/agent';
import {
  STYLE_OBSERVATION_FIELDS,
  destinationDecision,
  styleProfileSchema,
  type StyleProfile,
} from '@qaai/shared';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connection, logger, prisma } from '../context.js';
import { materialiseRepoWorkspace } from '../repo-materialise.js';
import { nodeWorkspaceFileReader } from '../lib/workspace.js';
import { open as openSecret } from '../vault.js';

/**
 * Its own queue, declared beside its processor.
 *
 * NOT in `QUEUE_NAMES` (packages/shared/src/constants.ts), for the same reason
 * and in the same shape as `RETENTION_QUEUE`, `BACKUP_QUEUE`, `ACTIONS_QUEUE`
 * and `RECOMPUTE_COVERAGE_QUEUE`: that file has an owner and this change is not
 * it. The pattern does not require an entry — `npm run check:wiring` reads this
 * literal and pins it to the `register(...)` call in index.ts, so the producer
 * and the consumer cannot drift apart without CI saying so.
 */
export const STYLE_PROFILE_QUEUE = 'qaai.style-profile';

/**
 * How long a stored profile is believed.
 *
 * A WEEK, and the number is an argument rather than a default.
 *
 * It is not short because a house style does not drift quickly: a repository's
 * assertion library, fixture mechanism and locator strategy change when a team
 * decides to change them, which is a quarterly event. The capability probe's
 * window is ten minutes because a container rebuild changes its answer; nothing
 * changes this one in an afternoon.
 *
 * It is not long because THE THING THAT MAKES A STORED PROFILE WRONG IS NOT THE
 * STYLE DRIFTING — IT IS THE REPOSITORY GROWING. A profile computed when a
 * project had four tests reports MIXED naming and an UNKNOWN layout, because
 * four files cannot clear `confidenceFor`'s floors; the same repository at a
 * hundred and twenty files has a HIGH-confidence answer for most of the
 * fourteen fields. A quarterly window would keep telling the generator "not
 * established" about a repository that had become perfectly legible, and that
 * is precisely the sentence this feature exists to stop saying.
 *
 * The cost of a week is one repository archive per project per week, read by
 * every generation in that week. A daily window multiplies the downloads by
 * seven for an answer that moves monthly.
 */
export const STYLE_PROFILE_FRESH_MS = 7 * 24 * 60 * 60_000;

/**
 * The coalescing window.
 *
 * A generate batch finishing and a source analysis landing arrive within
 * seconds of each other, and both want the same single download. The delay plus
 * the job id below means one job for the burst.
 *
 * It is NOT what makes a second request cheap — the freshness check is, and it
 * costs one SELECT — so the window is short. Its whole job is to stop two
 * triggers from both materialising a repository in the same second, which the
 * job id alone cannot do once the first job has completed and its key has been
 * removed.
 */
export const STYLE_PROFILE_WINDOW_MS = 60_000;

/**
 * ONE ATTEMPT, and this is the unusual direction so it gets the sentence.
 *
 * The write is idempotent — two columns derived entirely from inputs re-read at
 * run time — so a retry could not corrupt anything. It is still one attempt,
 * because a retry re-downloads the archive: the failures that a second attempt
 * would fix (a GitHub 5xx, a dropped connection) are also the ones the NEXT
 * demand-driven request fixes for free, and the failures it would not fix (a
 * cap breach, an uninstalled App) would pay for a second 128MB download to
 * learn the same thing twice.
 */
export const STYLE_PROFILE_ATTEMPTS = 1;

/**
 * Why a profile was asked for. Logged, so a surprising write is traceable.
 *
 * `generate` is the demand signal — somebody is writing tests into this
 * repository, so the next batch should know its conventions. `source-analysis`
 * is the nearest in-worker signal that a repository LANDED, which is the same
 * proxy `requestRecompute` uses and for the same reason: the row itself is
 * written by the API. `requested` is an operator or an endpoint asking directly.
 */
export const STYLE_PROFILE_REASONS = ['generate', 'source-analysis', 'requested'] as const;
export type StyleProfileReason = (typeof STYLE_PROFILE_REASONS)[number];

/**
 * Ids and a reason only — the same rule as every other payload in this system
 * (see the header of packages/shared/src/jobs.ts). Nothing measured travels on
 * the job: the processor re-reads the project row and the repository, so a job
 * that waited out its window measures the repository as it is when it runs.
 */
export interface StyleProfileJob {
  orgId: string;
  projectId: string;
  reason: StyleProfileReason;
  /** Bypass the freshness window. No trigger ever does; an operator can. */
  force?: boolean;
}

// ─── The producer ────────────────────────────────────────────────────────────

/**
 * The coalescing key. One in-flight computation per project, by construction.
 *
 * Note what is NOT in it: the reason. Including it would give each trigger its
 * own job and defeat the mechanism — a generate finishing and an analysis
 * landing share nothing except the project they are both about.
 */
export function styleProfileJobId(projectId: string): string {
  return `style-profile-${projectId}`;
}

/**
 * Exported so the test can assert the settings the coalesce actually rests on —
 * the job id, the window and the two removals — rather than asserting that a
 * function was called.
 *
 * BOTH REMOVALS ARE LOAD-BEARING AND NEITHER IS HOUSEKEEPING. A BullMQ job id
 * is a Redis key: a retained completed — or worse, FAILED — job keeps that key,
 * and every later `add()` for the project collapses onto the corpse and returns
 * a Job object carrying the new data, so the caller cannot tell. That turns
 * "one computation per project in flight" into "one computation per project
 * EVER", which would freeze a repository's conventions at whatever they were
 * the first time anybody generated a test. Measured against this repo's own
 * Redis and BullMQ by the comment on `enqueueExplore` in queues.ts, which paid
 * for the lesson.
 */
export function styleProfileJobOptions(projectId: string): {
  jobId: string;
  delay: number;
  attempts: number;
  removeOnComplete: boolean;
  removeOnFail: boolean;
} {
  return {
    jobId: styleProfileJobId(projectId),
    delay: STYLE_PROFILE_WINDOW_MS,
    attempts: STYLE_PROFILE_ATTEMPTS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

let styleProfileQueue: Queue | null = null;

/**
 * Built lazily, so importing this module for a unit test does not open a Redis
 * connection — the same shape and the same reason as processors/backup.ts,
 * processors/actions.ts and processors/recompute-coverage.ts.
 */
function queue(): Queue {
  styleProfileQueue ??= new Queue(STYLE_PROFILE_QUEUE, { connection });
  return styleProfileQueue;
}

export async function enqueueStyleProfile(job: StyleProfileJob): Promise<void> {
  await queue().add(STYLE_PROFILE_QUEUE, job, styleProfileJobOptions(job.projectId));
}

export async function closeStyleProfileQueue(): Promise<void> {
  if (styleProfileQueue) await styleProfileQueue.close();
  styleProfileQueue = null;
}

/**
 * Ask for a profile. NEVER THROWS.
 *
 * The never-throwing is the contract, not politeness. Every caller is a
 * `finally` block wrapped around somebody else's job — a generate batch that
 * wrote nine tests, an analysis that produced a plan — and a throw from a
 * `finally` REPLACES the error the job actually failed with, so a Redis blip
 * would be reported as a generation failure. The same contract
 * `requestRecompute` states and tests.
 *
 * Returns the job it enqueued, or null, and says which in the log.
 */
export async function requestStyleProfile(
  job: StyleProfileJob,
  deps: { enqueue?: (job: StyleProfileJob) => Promise<void> } = {},
): Promise<StyleProfileJob | null> {
  try {
    await (deps.enqueue ?? enqueueStyleProfile)(job);
    logger.debug(
      { projectId: job.projectId, reason: job.reason, jobId: styleProfileJobId(job.projectId) },
      'house-style profile requested',
    );
    return job;
  } catch (err) {
    logger.error(
      { err, projectId: job.projectId, reason: job.reason },
      'could not request a house-style profile; the stored one stays as it is until the next trigger',
    );
    return null;
  }
}

// ─── The filesystem, as a narrow injected interface ─────────────────────────

/**
 * What one directory entry is, as far as this module is concerned.
 *
 * `OTHER` is every entry that is not a plain file or a plain directory, and a
 * SYMBOLIC LINK IS THE ONE THAT MATTERS. It is never descended into and never
 * offered as a candidate: `anywhere -> /` makes `anywhere/etc/hosts` a path
 * with no `..` in it that is inside the root by every string check and resolves
 * to a real file outside it. `nodeWorkspaceFileReader` refuses it again at read
 * time, segment by segment; that belt exists because the two checks are
 * separately editable, not because either is optional.
 */
export type RepoTreeEntryKind = 'FILE' | 'DIRECTORY' | 'OTHER';

export interface RepoTreeEntry {
  /** A single path segment. Never a path; the walker joins it. */
  readonly name: string;
  readonly kind: RepoTreeEntryKind;
}

/**
 * The whole filesystem surface the walk is allowed.
 *
 * One method, taking a repo-relative directory (`''` is the root) and returning
 * null when it could not be listed — which is NOT an empty directory, and the
 * walk counts the two apart.
 */
export interface RepoTree {
  readonly entries: (directory: string) => Promise<readonly RepoTreeEntry[] | null>;
}

/** Entries the walk will look at. A cap, so it is counted and reported. */
export const MAX_TREE_ENTRIES = 50_000;

/**
 * Directory depth the walk will descend.
 *
 * Generous, because a Maven monorepo's `src/test/java/com/acme/billing/...` is
 * genuinely eight deep before the file. Bounded because a cyclic mount under a
 * directory nothing refused is the one way this loop does not terminate.
 */
export const MAX_TREE_DEPTH = 24;

/** What the walk found, and every hole in it. */
export interface RepoListing {
  /** Repo-relative paths, sorted. Candidates, not conclusions. */
  readonly paths: readonly string[];
  /**
   * Directories `destinationDecision` refused, and therefore were not
   * descended into.
   *
   * Their OWN PATH is in `paths` as well, on purpose: `learnStyle` then refuses
   * each one for itself and records it in `StyleProfile.filesSkipped` with
   * reason FORBIDDEN_DIRECTORY, so a repository whose tests all live under
   * `node_modules` is distinguishable in the STORED PROFILE from a repository
   * with no tests. Pruning them silently here would make those two rows
   * identical, which is a thing reported as an absence that was a refusal.
   */
  readonly directoriesRefused: number;
  /** Directories that could not be listed. Our hole, not a fact about the tree. */
  readonly directoriesUnlistable: number;
  /** Link and device entries, neither descended nor offered. A refusal, counted. */
  readonly linksRefused: number;
  /** Entries {@link MAX_TREE_ENTRIES} refused to look at. A cap, counted. */
  readonly entriesOmitted: number;
  /** Directories {@link MAX_TREE_DEPTH} refused to descend. A cap, counted. */
  readonly directoriesTooDeep: number;
}

/**
 * Walk a materialised checkout into a candidate path list.
 *
 * Breadth-first, with every level SORTED BY NAME before it is admitted, and the
 * RESULT sorted again on the way out. Two properties come from that and both
 * are load-bearing: two walks of one tree produce the same list, and
 * {@link MAX_TREE_ENTRIES} keeps the SHALLOWEST entries rather than an
 * arbitrary slice — which is where a repository's tests and its manifests
 * actually are. A reproducible profile needs a reproducible listing, for the
 * same reason `MAX_SCANNED_FILES` sorts before it caps.
 *
 * Pure apart from the injected {@link RepoTree}: no `node:fs` in here, so the
 * refusals below are testable against a four-line fake rather than against a
 * real symlink somebody has to create.
 */
export async function walkRepoTree(tree: RepoTree): Promise<RepoListing> {
  const paths: string[] = [];
  let directoriesRefused = 0;
  let directoriesUnlistable = 0;
  let linksRefused = 0;
  let entriesOmitted = 0;
  let directoriesTooDeep = 0;

  let frontier: string[] = [''];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of frontier) {
      const entries = await tree.entries(directory);
      if (entries === null) {
        directoriesUnlistable += 1;
        continue;
      }
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
        if (paths.length >= MAX_TREE_ENTRIES) {
          entriesOmitted += 1;
          continue;
        }
        if (entry.kind === 'OTHER') {
          linksRefused += 1;
          continue;
        }
        if (entry.kind === 'FILE') {
          paths.push(path);
          continue;
        }
        /*
         * THE DENY LIST IS ASKED BEFORE THE DESCENT, which is where it is worth
         * anything: `node_modules` is one refusal here and a hundred thousand
         * refusals one level down. The directory's own path is still offered, so
         * the refusal appears in the stored profile rather than only in a count
         * this module keeps.
         */
        if (destinationDecision({ path }).verdict === 'REFUSED') {
          directoriesRefused += 1;
          paths.push(path);
          continue;
        }
        next.push(path);
      }
    }
    if (next.length > 0 && depth === MAX_TREE_DEPTH - 1) directoriesTooDeep += next.length;
    frontier = next;
  }

  return {
    paths: paths.sort((a, b) => a.localeCompare(b)),
    directoriesRefused,
    directoriesUnlistable,
    linksRefused,
    entriesOmitted,
    directoriesTooDeep,
  };
}

/**
 * The one adapter. Everything above is pure.
 *
 * `readdir` with `withFileTypes` does not follow links, and a link is reported
 * as `OTHER` and dropped by the walk — so the only paths that come out of here
 * are ones every segment of which was a real directory when it was read.
 */
export function nodeRepoTree(root: string): RepoTree {
  return {
    entries: async (directory) => {
      try {
        const dirents = await readdir(directory === '' ? root : join(root, directory), {
          withFileTypes: true,
        });
        return dirents.map((dirent) => ({
          name: dirent.name,
          kind: dirent.isFile() ? 'FILE' : dirent.isDirectory() ? 'DIRECTORY' : 'OTHER',
        }));
      } catch {
        // The REASON is not carried: an errno from the worker's temp directory
        // is an operational detail, and the only thing the profile needs is
        // that a directory was not read. It is counted, which is the finding.
        return null;
      }
    },
  };
}

// ─── Opening a project's test files ─────────────────────────────────────────

/** A repository ready to be read, or a sentence saying why there is none. */
export type OpenedTestFiles =
  | {
      kind: 'ready';
      source: TestFileSource;
      listing: RepoListing;
      /** `owner/name@ref`, for the log. Never credential-bearing. */
      provenance: string;
      /** Removes the workspace. Idempotent; never throws. */
      close: () => Promise<void>;
    }
  | { kind: 'unavailable'; why: string };

/** What the processor reads about a project. Narrow, so `select` can prove it. */
export interface StyleProfileProjectRow {
  id: string;
  repoFullName: string | null;
  repoInstallationId: string | null;
  defaultBranch: string;
  styleProfile: unknown;
  styleProfileComputedAt: Date | null;
}

export interface StyleProfileDeps {
  /**
   * Opens the project's repository. The default materialises a checkout; a test
   * passes a Map-backed source, because a unit test that downloads a tarball is
   * an integration test wearing a disguise.
   */
  open?: (args: {
    job: StyleProfileJob;
    project: StyleProfileProjectRow;
  }) => Promise<OpenedTestFiles>;
  /**
   * The scan. The default is the real `learnStyle`.
   *
   * IT IS A SEAM FOR ONE REASON AND THE REASON IS A BRANCH, not convenience.
   * The real producer CANNOT emit a profile `styleProfileSchema` refuses —
   * `confidenceFor` is the only thing that may set a confidence, every minted
   * value is bounded to its own column's ceiling, and `styleProfileProblems`
   * refuses the rest — so the refusal branch below is unreachable from any
   * filesystem a test could hand in. Without this seam that branch would be
   * code with no test, which is how a guard comes to be decoration; with it,
   * the guard is exercised against the real schema and the real log line.
   */
  learn?: (source: TestFileSource) => Promise<LearnedStyle>;
  /** Injected so the freshness boundary is assertable rather than approximate. */
  now?: () => Date;
}

/**
 * How long the archive download and extraction get.
 *
 * Shorter than a run's budget on purpose: nothing is waiting on this job, and a
 * repository that takes four minutes to download is one whose profile is better
 * computed on the next trigger than held a worker lane open for.
 */
export const STYLE_PROFILE_TIMEOUT_MS = 4 * 60_000;

/**
 * The production implementation: materialise the repository, walk it, and read
 * through the symlink-refusing reader.
 *
 * `materialiseRepoWorkspace` never throws for an expected condition — an
 * unconnected project, a half-configured App, a 404, a cap breach — so every
 * one of those comes back as `unavailable` with the sentence it wrote, and this
 * processor's job is to log that and store nothing.
 */
async function materialiseAndWalk(args: {
  job: StyleProfileJob;
  project: StyleProfileProjectRow;
}): Promise<OpenedTestFiles> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STYLE_PROFILE_TIMEOUT_MS);
  let outcome;
  try {
    outcome = await materialiseRepoWorkspace({
      // The id only names a temp directory. A profile is about the project's
      // DEFAULT BRANCH, never a commit — there is no run here and no commit to
      // be about, and `commitSha: null` is what makes the materialiser fall
      // through to `defaultBranch`.
      runId: args.project.id,
      repo: {
        repoFullName: args.project.repoFullName,
        repoInstallationId: args.project.repoInstallationId,
        defaultBranch: args.project.defaultBranch,
        commitSha: null,
      },
      unseal: openSecret,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (outcome.kind !== 'ready') return { kind: 'unavailable', why: outcome.why };

  const { source, listing } = await openWorkspaceTestFiles(outcome.workspace.root);
  return {
    kind: 'ready',
    source,
    listing,
    provenance: outcome.workspace.source,
    close: outcome.cleanup,
  };
}

/**
 * Turn a materialised checkout into the two functions `learnStyle` needs.
 *
 * Separated from {@link materialiseAndWalk} so a caller that ALREADY HOLDS A
 * WORKSPACE can read the house style off it without downloading a second
 * archive. That caller is `processGenerate` once it materialises a repository
 * for `GenerateTestArgs.repository`: `learnedStyle` — the field that makes
 * `selectExemplars` run, and without which no existing test is ever quoted to
 * the model — needs the file BODIES, which cannot be cached on `Project` and
 * are therefore only available where a checkout is. Two lines there:
 *
 *     const house = await openWorkspaceTestFiles(workspace.root);
 *     const learned = await learnStyle(house.source);   // then pass `learned`
 *
 * It is exported rather than inlined for that reason and not for tidiness; the
 * exact edit is in this change's handover.
 */
export async function openWorkspaceTestFiles(
  root: string,
): Promise<{ source: TestFileSource; listing: RepoListing }> {
  const listing = await walkRepoTree(nodeRepoTree(root));
  const reader = nodeWorkspaceFileReader(root);
  return {
    listing,
    source: {
      list: () => Promise.resolve(listing.paths),
      /*
       * ABSENT AND REFUSED BOTH BECOME null, WHICH `learnStyle` RECORDS AS
       * UNREADABLE. That is a real loss of resolution and it is the honest
       * direction: UNREADABLE's own sentence is "the file could not be read, so
       * it is absent and not empty", which is true of both. What must never
       * happen is either of them becoming `''`, which the learner records as
       * EMPTY — a fact about the repository rather than a hole in our reading.
       */
      read: async (path) => {
        const entry = await reader.read(path);
        return entry.kind === 'FILE' ? entry.text : null;
      },
    },
  };
}

// ─── The outcome ─────────────────────────────────────────────────────────────

/**
 * What one run of this processor did. A CLOSED SET, because the log line is
 * where an operator looks when a customer asks why their generated tests do not
 * match their house style, and "it ran" is not an answer.
 *
 * NO ZOD PARITY TEST FOR THIS UNION, and that is deliberate rather than
 * forgotten: nothing stores it. It is a return value and a log field, so the
 * compiler-enforced presence record on {@link STYLE_PROFILE_OUTCOME_WHY} is the
 * whole guard — a run-time `.options` test here would be a test of a schema
 * that exists only to be tested.
 */
export const STYLE_PROFILE_OUTCOMES = ['STORED', 'FRESH', 'UNAVAILABLE', 'REFUSED'] as const;
export type StyleProfileOutcomeKind = (typeof STYLE_PROFILE_OUTCOMES)[number];

/** One line each, as a compiler-enforced presence record. */
export const STYLE_PROFILE_OUTCOME_WHY = {
  STORED: 'the repository was read and the profile was written',
  FRESH: 'a stored profile is inside the freshness window, so nothing was downloaded',
  UNAVAILABLE: 'the repository could not be materialised, so NOTHING was stored',
  REFUSED: 'the computed profile did not validate, so NOTHING was stored',
} as const satisfies Record<StyleProfileOutcomeKind, string>;

export interface StyleProfileOutcome {
  readonly kind: StyleProfileOutcomeKind;
  /** The sentence an operator reads. Never "it ran". */
  readonly why: string;
  /** Null for every outcome but STORED — never 0, and never an empty profile. */
  readonly profile: StyleProfile | null;
  /** The scan's own numbers, when a scan happened. Null when none did. */
  readonly learned: LearnedStyle | null;
  /** The walk's numbers, when a walk happened. */
  readonly listing: RepoListing | null;
}

// ─── The processor ───────────────────────────────────────────────────────────

/**
 * Is this stored profile still worth believing?
 *
 * The PAIR is checked, not just the date. The column's schema comment says
 * `styleProfileComputedAt` is NULL exactly when `styleProfile` is NULL, and a
 * row where one is set and the other is not is drift — `readStyleProfile`
 * refuses such a row outright and flags the test, so leaving it alone would
 * leave the project permanently profile-less while this job kept reporting it
 * fresh. Either half missing means recompute.
 */
export function styleProfileIsFresh(
  project: Pick<StyleProfileProjectRow, 'styleProfile' | 'styleProfileComputedAt'>,
  now: Date,
): boolean {
  const { styleProfile, styleProfileComputedAt } = project;
  if (styleProfile === null || styleProfile === undefined) return false;
  if (styleProfileComputedAt === null) return false;
  return now.getTime() - styleProfileComputedAt.getTime() < STYLE_PROFILE_FRESH_MS;
}

/**
 * Compute and store one project's house style.
 *
 * Throws only for a condition a retry or an operator has to see: a project that
 * does not exist in this org, or a database write that failed. Everything else
 * — an unreachable repository, a profile that did not validate — is an outcome
 * with a sentence, because the job DID its work and the answer is that there is
 * no profile to store.
 */
export async function processStyleProfile(
  job: StyleProfileJob,
  deps: StyleProfileDeps = {},
): Promise<StyleProfileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const project = await prisma.project.findFirst({
    where: { id: job.projectId, orgId: job.orgId },
    /*
     * Narrowed deliberately, and `select` is what makes a Prisma fake able to
     * prove a field was dropped from this query. Nothing else on the row is
     * read: in particular NOT `primaryLanguage` or `primaryFramework`, which
     * are the GENERATOR's ecosystem vocabulary and not the 53-id runner
     * vocabulary `LearnStyleOptions.ecosystemHint` speaks — see the note on the
     * `learnStyle` call below.
     */
    select: {
      id: true,
      repoFullName: true,
      repoInstallationId: true,
      defaultBranch: true,
      styleProfile: true,
      styleProfileComputedAt: true,
    },
  });
  if (!project) throw new Error(`Project ${job.projectId} not found for org ${job.orgId}`);

  if (!job.force && styleProfileIsFresh(project, now)) {
    const outcome: StyleProfileOutcome = {
      kind: 'FRESH',
      why: `${STYLE_PROFILE_OUTCOME_WHY.FRESH} (computed ${project.styleProfileComputedAt?.toISOString() ?? 'at an unknown time'})`,
      profile: null,
      learned: null,
      listing: null,
    };
    logger.debug({ projectId: job.projectId, reason: job.reason }, outcome.why);
    return outcome;
  }

  const opened = await (deps.open ?? materialiseAndWalk)({ job, project });
  if (opened.kind === 'unavailable') {
    const outcome: StyleProfileOutcome = {
      kind: 'UNAVAILABLE',
      why: `${STYLE_PROFILE_OUTCOME_WHY.UNAVAILABLE} ${opened.why}`,
      profile: null,
      learned: null,
      listing: null,
    };
    logger.warn({ projectId: job.projectId, reason: job.reason }, outcome.why);
    return outcome;
  }

  try {
    /*
     * NO `ecosystemHint`, AND IT IS A DECISION. The hint exists to break a tie
     * between ecosystems whose import signatures are identical, from a runner
     * the CALLER had already detected. The only stored answer to that is
     * `CodebaseSnapshot.detection`, which is an unvalidated Json blob of
     * unknown age — and `readRepositoryRunner` now performs that same
     * measurement from the checkout in hand, which is both fresher and
     * validated by construction. Passing a stored hint would be an older
     * reading of the thing the scan is about to measure.
     */
    const learned = await (deps.learn ?? learnStyle)(opened.source);

    /*
     * THE PRODUCER ENDS AT THE VALIDATOR THE READ PATH RUNS. `readStyleProfile`
     * in processors/generate.ts parses this column with `styleProfileSchema` and
     * turns a failure into a review flag on every test in the batch. A producer
     * that stores what that parser refuses converts its own bug into a sentence
     * blaming the stored data, which is eight producer-versus-validator
     * disagreements in this repository found one at a time.
     */
    const parsed = styleProfileSchema.safeParse(learned.profile);
    if (!parsed.success) {
      const outcome: StyleProfileOutcome = {
        kind: 'REFUSED',
        why: `${STYLE_PROFILE_OUTCOME_WHY.REFUSED} ${describeProfileRefusal(parsed.error.issues)}`,
        profile: null,
        learned,
        listing: opened.listing,
      };
      logger.error({ projectId: job.projectId, reason: job.reason }, outcome.why);
      return outcome;
    }

    /*
     * ONE UPDATE, BOTH COLUMNS. `readStyleProfile` cross-checks the pair and
     * refuses a profile with no date; two updates could leave exactly that row
     * behind if the second failed, and the project would then be permanently
     * profile-less with a flag blaming its stored data.
     */
    await prisma.project.update({
      where: { id: project.id },
      data: { styleProfile: parsed.data, styleProfileComputedAt: now },
    });

    const outcome: StyleProfileOutcome = {
      kind: 'STORED',
      why: STYLE_PROFILE_OUTCOME_WHY.STORED,
      profile: learned.profile,
      learned,
      listing: opened.listing,
    };
    logger.info(
      {
        projectId: job.projectId,
        reason: job.reason,
        source: opened.provenance,
        computedAt: now.toISOString(),
        ...styleProfileFacts(learned, opened.listing),
      },
      styleProfileSentence(learned, opened.listing),
    );
    return outcome;
  } finally {
    // The workspace is half a gigabyte at the ceiling and the processor is the
    // only thing that knows about it. `cleanup` never throws, and the `finally`
    // is what makes a throw above cost disk rather than leak it.
    await opened.close();
  }
}

/**
 * The top-level keys of a `StyleProfile`, as a closed set.
 *
 * Derived from `STYLE_OBSERVATION_FIELDS` — the compiler-enforced presence
 * record for the fourteen observation fields — plus the four structural keys,
 * rather than being listed twice. A fifteenth observation field added there
 * appears here without an edit.
 */
const PROFILE_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(STYLE_OBSERVATION_FIELDS),
  'scopeRoot',
  'filesRead',
  'filesSkipped',
  'helpers',
]);

/**
 * What a zod failure may say about a style profile.
 *
 * THE FIELD, NEVER THE VALUE — AND A ZOD PATH IS NOT AUTOMATICALLY A FIELD.
 *
 * The obvious implementation joins `issue.path` and logs it, and that LEAKS,
 * measured rather than feared: `styleProfileSchema`'s `superRefine` forwards
 * `styleProfileProblems`, whose `field` for a bad helper is
 * `helpers.<the helper's own name>` — so a profile carrying a helper called
 * `login as member` produced the path `helpers.login as member`, and the
 * sentence an operator reads contained a customer identifier. Every leaf of
 * this document is customer-authored (a helper name, a test-id attribute, a
 * layout root, a quoted line of somebody else's test), and zod itself puts the
 * offending VALUE in `message` for several of its checks.
 *
 * So: the message is dropped, each path's FIRST segment is cut at its first
 * `.`, and the result is kept only if it is one of the profile's own keys.
 * Anything else is counted as unnamed. The depth is not reported — `helpers`
 * plus the issue count is what an operator needs, and `helpers.0.name` buys
 * nothing that is worth a vocabulary this function has to trust.
 */
function describeProfileRefusal(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const named = new Set<string>();
  let unnamed = 0;
  for (const issue of issues) {
    const first = issue.path[0];
    const head = typeof first === 'string' ? (first.split('.')[0] ?? '') : '';
    if (PROFILE_FIELD_NAMES.has(head)) named.add(head);
    else unnamed += 1;
  }
  const parts = [...named].sort();
  if (unnamed > 0) parts.push(`${unnamed} issue(s) on no named field`);
  return (
    `${issues.length} issue(s) were refused by styleProfileSchema, on: ` +
    `${parts.length > 0 ? parts.join(', ') : 'nothing this writer could name'}.`
  );
}

/**
 * The numbers an operator can GROUP BY, as fields rather than only as prose.
 *
 * Every cap and hole travels: "how many projects had their tests inside a
 * refused directory last week" is a question nobody can ask of a sentence.
 */
export function styleProfileFacts(
  learned: LearnedStyle,
  listing: RepoListing,
): Record<string, number | string | null> {
  return {
    filesOffered: learned.filesOffered,
    filesRead: learned.profile.filesRead,
    filesSkipped: learned.filesSkipped.length,
    filesSkippedOmitted: learned.filesSkippedOmitted,
    fieldsBelowThreshold: learned.belowThreshold.length,
    runner: learned.profile.runner.value,
    runnerConfidence: learned.profile.runner.confidence,
    /*
     * NULL AND NEVER 0 WHEN NO RUNNER WAS REPORTED. 0 beside a null runner
     * would read as "every vote was the file's own", which is the most
     * flattering reading of a field nobody established.
     */
    runnerFromRepository: learned.profile.runner.value === null ? null : learned.runnerFromRepository,
    runnerAmbiguous: learned.runnerAmbiguous,
    helpers: learned.profile.helpers.length,
    helpersRefused: learned.helpersRefused,
    helpersOmitted: learned.helpersOmitted,
    treePaths: listing.paths.length,
    treeDirectoriesRefused: listing.directoriesRefused,
    treeDirectoriesUnlistable: listing.directoriesUnlistable,
    treeLinksRefused: listing.linksRefused,
    treeEntriesOmitted: listing.entriesOmitted,
    treeDirectoriesTooDeep: listing.directoriesTooDeep,
  };
}

/**
 * The sentence, and every clause in it is emitted only when its own number is
 * non-zero.
 *
 * THE REASON MUST BE THE ONE THAT BIT. The exemplar briefing shipped a version
 * of this that blamed every omission on a character budget it had never
 * touched, and a reader acting on that sentence raises the budget and sees no
 * change. So the scan cap, the refused directories, the unlistable
 * directories, the links and the depth cap each get their own clause or no
 * clause at all.
 */
export function styleProfileSentence(learned: LearnedStyle, listing: RepoListing): string {
  const established = learned.belowThreshold.length;
  const parts: string[] = [
    `read ${learned.profile.filesRead} test file(s) of ${learned.filesOffered} path(s) offered; ` +
      `${established} field(s) fell below the evidence floor`,
  ];

  const runner = learned.profile.runner.value;
  if (runner === null) {
    parts.push(`the runner is UNKNOWN (${learned.repositoryRunner.why || 'no file voted for one'})`);
  } else if (learned.runnerFromRepository > 0) {
    parts.push(
      `the runner is ${runner}, and ${learned.runnerFromRepository} of the ` +
        `${learned.profile.runner.filesSeen} agreeing file(s) were attributed to it by this ` +
        "repository's own configuration rather than by their own imports",
    );
  } else {
    parts.push(`the runner is ${runner}, from the files' own imports`);
  }

  const skipped = new Map<string, number>();
  for (const entry of learned.filesSkipped) {
    skipped.set(entry.reason, (skipped.get(entry.reason) ?? 0) + 1);
  }
  for (const [reason, count] of [...skipped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`${count} path(s) were not read because ${reason}`);
  }
  if (learned.filesSkippedOmitted > 0) {
    parts.push(`${learned.filesSkippedOmitted} further skipped path(s) were not listed`);
  }
  if (listing.directoriesUnlistable > 0) {
    parts.push(`${listing.directoriesUnlistable} directory(ies) could not be listed at all`);
  }
  if (listing.linksRefused > 0) {
    parts.push(`${listing.linksRefused} link or device entry(ies) were refused rather than followed`);
  }
  if (listing.entriesOmitted > 0) {
    parts.push(`${listing.entriesOmitted} entry(ies) were past the ${MAX_TREE_ENTRIES}-entry walk cap`);
  }
  if (listing.directoriesTooDeep > 0) {
    parts.push(
      `${listing.directoriesTooDeep} directory(ies) were deeper than the ${MAX_TREE_DEPTH}-level walk cap`,
    );
  }

  return `house-style profile stored: ${parts.join('; ')}.`;
}
