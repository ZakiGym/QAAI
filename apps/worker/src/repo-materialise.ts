/**
 * Materialise the customer's repository into a workspace this run can execute in.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * INTEGRATION, UNIT_GEN and MUTATION run a command the customer named, and
 * every one of them resolved its working directory from `process.cwd()` — which
 * on the cloud worker is QAAI's own checkout. `npx vitest run` ran QAAI's suite
 * and filed the result as the customer's. `mvn test` reported "there is no POM
 * in this directory" as a verdict on their application. Nothing in the tree ever
 * put the customer's code on the worker's disk: `buildRepoTree` (apps/api) only
 * ever served the zip-export route, and `CodebaseSnapshot` stores paths with no
 * contents by design.
 *
 * So this module does the one thing that was missing: it fetches the repository
 * the project is connected to, writes it into a temp directory owned by the run,
 * and hands the root to the plugins. The run processor removes it again in a
 * `finally`, so a throw, a cancel and a clean finish all take the same path.
 *
 * ── What gets materialised, and from where ──────────────────────────────────
 *
 * The WHOLE tree at one commit, fetched as a tarball through the project's
 * GitHub App installation — `GET /repos/{owner}/{repo}/tarball/{ref}` — where
 * the ref is `Run.commitSha` when the run has one (a CI run tests THAT commit)
 * and the project's default branch otherwise.
 *
 * Whole rather than a subset, deliberately. A subset means guessing which files
 * the customer's own command needs; guessing wrong turns a suite that passes in
 * their CI into a confusing failure here, and "QAAI decided your build did not
 * need that file" is not a sentence this product can defend. The caps below are
 * the defence instead, and they refuse the repository outright rather than
 * quietly delivering half of it.
 *
 * Three things are NOT materialised, each for a stated reason:
 *
 *  - **Symlinks and hardlinks are skipped.** A link entry in a tarball is the
 *    classic extraction escape (`node_modules -> /`), and honouring one would
 *    let a hostile repository read or overwrite anything the worker can reach.
 *    They are counted, and the count is reported, because a build that needed a
 *    link will fail oddly and deserves a breadcrumb.
 *  - **The QAAI test tree (`buildRepoTree`) is not overlaid.** It emits a
 *    `package.json`, a runner config, a `.gitignore` and a README; writing those
 *    over a real checkout would replace the customer's manifest with QAAI's and
 *    produce a verdict about a repository that exists nowhere. The one generated
 *    file a run DOES need — a UNIT_GEN test's source — is written by the plugin
 *    that runs it, at `test.filePath`, through the workspace path guard.
 *  - **`fixtures/`** stays out for the same reason: it would shadow a directory
 *    the customer may already have. Fixtures belong to the generated-spec
 *    harness, whose workspaces are fresh temp dirs holding nothing else.
 *
 * ── Where, and never where ──────────────────────────────────────────────────
 *
 * `mkdtemp` under the OS temp directory, one per run. Explicitly NOT under
 * `process.cwd()` and not beside the installed `node_modules` (the Playwright
 * harness puts its throwaway spec workspaces there for module-resolution
 * reasons; a whole third-party repository with a `postinstall` in it is a very
 * different proposition). A tenant's repository must never be written into, or
 * next to, the worker's own source tree.
 *
 * ── When there is no connected repository ───────────────────────────────────
 *
 * Then these test types CANNOT RUN, and that is reported as such: the run
 * processor records SKIPPED with the reason from {@link repoUnavailableMessage}
 * — the same shape the repo already uses for a missing plugin
 * (`reasonUnsupported`), an uninstalled browser, and an ecosystem that needs a
 * project. It is never a pass, and never a bare failure blamed on the
 * application.
 */

import { createGunzip } from 'node:zlib';
import { mkdir, mkdtemp, open as openFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { TestType } from '@qaai/shared';
/*
 * The workspace contract lives in the runner package but is not on its public
 * `index.ts` barrel, which this change does not own — so it is imported by
 * path, exactly as this worker already imports apps/api's GitHub App helpers
 * below. Both resolve to the same module the plugins import.
 */
import {
  resolveInsideWorkspace,
  type RunWorkspace,
} from '../../../packages/runner/src/run-workspace.js';
import {
  GITHUB_API_HOST,
  githubRepoSlug,
  installationToken,
  loadAppConfig,
  type AppConfig,
  type Unsealer,
} from '../../api/src/lib/github-app.js';

/**
 * The test types that cannot run without the customer's repository on disk,
 * whatever their spec says.
 *
 * INTEGRATION and UNIT_GEN shell out to a command whose cwd is a path inside
 * the repo; MUTATION rewrites the repo's source and re-runs its suite.
 *
 * This set is NOT the whole answer — see `testNeedsRepository`. Four more
 * types need a checkout only sometimes, and using this set alone is why a
 * suite made entirely of CONTRACT, PROTOCOL, MOBILE or declared-command E2E
 * tests materialised nothing and then skipped every test in it: honest, and
 * useless.
 */
export const REPO_DEPENDENT_TEST_TYPES: ReadonlySet<TestType> = new Set<TestType>([
  'INTEGRATION',
  'UNIT_GEN',
  'MUTATION',
]);

/**
 * Whether THIS test needs the repository, spec included.
 *
 * The conditional cases, each of which has a perfectly good no-checkout form
 * that must not be made to pay for the other:
 *
 *   CONTRACT  — a pact or schema loaded from a URL needs nothing; one named as
 *               a repo-relative path needs the checkout.
 *   PROTOCOL  — gRPC server reflection needs nothing; a `protoPath` or an
 *               `importPaths` entry needs the checkout.
 *   MOBILE    — APPIUM hands its `app` to the Appium server, which may be a
 *               device farm; the four CLI drivers run the customer's build.
 *   E2E/SMOKE — QAAI's own Playwright harness needs nothing; a test that
 *               declares its own command runs it inside the repo.
 *
 * Over-reporting is the safe direction and under-reporting is not: a run that
 * materialises a repo it did not need wastes a download, while a run that
 * skips it turns every affected test into a skip that does not block a gate.
 * So anything unreadable here answers TRUE, and says why in a comment rather
 * than guessing quietly.
 */
/**
 * A spec is persisted as JSON, so it arrives as `unknown` and may be null, an
 * array, or a string. Anything that is not a plain object carries no fields to
 * read, and the caller treats that as "unreadable" rather than "empty".
 */
function specRecord(spec: unknown): Record<string, unknown> | null {
  return typeof spec === 'object' && spec !== null && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)
    : null;
}

export function testNeedsRepository(test: { type: TestType; spec?: unknown }): boolean {
  if (REPO_DEPENDENT_TEST_TYPES.has(test.type)) return true;

  const spec = specRecord(test.spec);

  switch (test.type) {
    case 'CONTRACT': {
      if (!spec) return false;
      /*
       * `contractDocumentRef` in packages/shared/src/schemas.ts accepts EITHER
       * an http(s) URL or a workspace-relative path, so the key being present
       * settles nothing — a pact broker URL touches no file. `pactPath` is the
       * pact kind's field and `specPath` the openapi kind's.
       *
       * A non-URL path answers TRUE even though the plugin would also look in
       * the run's `fixtures/`, which can satisfy it with no checkout at all.
       * That costs a download QAAI may not have needed. The other direction
       * costs a SKIPPED test that does not block a gate, which is how a suite
       * goes green over work nobody did.
       */
      return ['pactPath', 'specPath'].some((key) => {
        const value = spec[key];
        return typeof value === 'string' && value !== '' && !/^https?:\/\//i.test(value);
      });
    }
    case 'PROTOCOL': {
      if (!spec) return false;
      // Server reflection needs nothing on disk; a .proto does.
      if (typeof spec.protoPath === 'string' && spec.protoPath !== '') return true;
      return Array.isArray(spec.importPaths) && spec.importPaths.length > 0;
    }
    case 'MOBILE': {
      // APPIUM hands its `app` to the Appium server, which may be a remote
      // host or a device farm where `app` is an id rather than a path. The
      // four CLI drivers run the customer's own build from the checkout.
      // Unreadable means assume a CLI driver: see the over-reporting rule.
      if (!spec) return true;
      return spec.driver !== 'APPIUM';
    }
    case 'E2E':
    case 'SMOKE': {
      /*
       * `routeFor` in packages/runner/src/plugins/e2e.ts treats a non-empty
       * `command` as the owner's explicit decision to run their own suite,
       * which happens inside their repository. Every other route — QAAI's own
       * Playwright harness, and the in-ecosystem route, which writes its
       * scratch tree under the system temp directory — needs no checkout.
       */
      if (!spec) return false;
      return typeof spec.command === 'string' && spec.command.trim() !== '';
    }
    default:
      return false;
  }
}

/**
 * Compressed bytes QAAI will pull for one run.
 *
 * 128 MiB is far past any source tree that a test command runs in — the Linux
 * kernel's own tarball is around 130 MiB and is the outlier, not the norm. A
 * repository bigger than this is build output, media, or an attack, and the
 * honest answer is "QAAI will not materialise this" rather than filling the
 * worker's disk on a tenant's instruction. Counted on the HTTP stream, so the
 * download is abandoned at the cap instead of being measured afterwards.
 */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

/**
 * Extracted bytes per run.
 *
 * Four times the archive cap, because gzip on source achieves roughly 3–4×. The
 * point of a SEPARATE cap is the decompression bomb: 128 MiB of zeros expands to
 * something like 130 GiB, which the archive cap alone cannot see. With a worker
 * running a handful of jobs at a time this bounds the workspaces to a couple of
 * gigabytes of disk in the worst case.
 */
export const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;

/**
 * Files per run. A very large monorepo tracks 30–40k files; past 50k the
 * extraction itself (one create + one write + one close per file) is a
 * meaningful share of the run's wall clock, and a tarball with a million
 * one-byte entries is a denial of service that no byte cap would catch.
 */
export const MAX_WORKSPACE_FILES = 50_000;

/**
 * Bytes in any single file.
 *
 * 64 MiB only trips on something pathological — a committed video, a vendored
 * binary, a checked-in database. A breach fails the whole materialisation
 * rather than skipping the file, because a workspace missing a file the
 * repository HAS is not the customer's repository, and every verdict produced
 * in it would be unexplainable. Being told which path and which cap is
 * actionable; a mystery failure inside their build is not.
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * The caps, as one value.
 *
 * They are DEFAULT ARGUMENTS and not environment variables on purpose:
 * `scripts/check-wiring.ts` fails a knob nobody deploying this could discover,
 * and an operator cannot be expected to find a tar-extraction limit. The only
 * caller that overrides them is this module's own test, which has to be able to
 * breach each one cheaply — a cap that is only exercised by a 128 MiB fixture
 * is a cap nobody ever proves works.
 */
export interface ExtractionLimits {
  archiveBytes: number;
  workspaceBytes: number;
  files: number;
  fileBytes: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  archiveBytes: MAX_ARCHIVE_BYTES,
  workspaceBytes: MAX_WORKSPACE_BYTES,
  files: MAX_WORKSPACE_FILES,
  fileBytes: MAX_FILE_BYTES,
};

/**
 * A hard ceiling on the WHOLE download, not just on the first byte.
 *
 * Two minutes is enough for the largest archive this module will accept over
 * any connection a worker should be running on, and a run that spends longer
 * than that fetching a repository has already lost the argument it exists to
 * win. The alternative to a ceiling is a stalled socket holding a worker slot
 * open indefinitely, which is the one outcome with no honest report attached.
 */
const FETCH_TIMEOUT_MS = 120_000;

/** The repository a project is connected to, as the run processor reads it. */
export interface ProjectRepoRef {
  /** `Project.repoFullName` — set when the GitHub App was installed on the repo. */
  repoFullName: string | null;
  repoInstallationId: string | null;
  defaultBranch: string;
  /** `Run.commitSha`, when this run is pinned to a commit. */
  commitSha: string | null;
}

/**
 * Downloading the archive, as one injectable step.
 *
 * It is a step rather than a `fetch` because the credential rule belongs inside
 * it: GitHub answers the tarball endpoint with a redirect to codeload, and
 * apps/api/src/lib/github-app.ts states the rule plainly — QAAI does not follow
 * a redirect while holding a credential. The default implementation therefore
 * asks with `redirect: 'manual'` and follows the `Location` itself, with no
 * Authorization header and only to a github.com host. Node's fetch would strip
 * the header on a cross-origin redirect anyway; relying on that would make the
 * safety of this request a property of somebody else's spec compliance.
 */
export type ArchiveDownloader = (args: {
  url: string;
  token: string;
  signal: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array> | null;
  /** Why it is not ok, when the status alone does not say. */
  detail?: string;
}>;

export interface MaterialisedWorkspace {
  workspace: RunWorkspace;
  /** Extracted bytes, for the log line. */
  bytes: number;
  /** Link entries that were refused rather than created. */
  skippedLinks: number;
  /** Removes the whole workspace. Idempotent; never throws. */
  cleanup: () => Promise<void>;
}

export type RepoWorkspaceOutcome =
  | ({ kind: 'ready' } & MaterialisedWorkspace)
  /**
   * The typed unrunnable outcome. `why` is one sentence naming what to
   * configure, and it is what the run processor writes onto the SKIPPED result.
   */
  | { kind: 'unavailable'; why: string };

/** The sentence a repo-dependent test carries when there was no workspace. */
export function repoUnavailableMessage(type: TestType, why: string): string {
  return (
    `${type} executes against your repository — your own command, in your own tree — and QAAI ` +
    'could not materialise one, so this test was not evaluated. No result here is a verdict on ' +
    `your application. ${why}`
  );
}

/** Refs that may be interpolated into a GitHub path. */
function safeRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;
  // `..` would climb the API path; a leading dash reads as a flag to anything
  // downstream; a trailing or leading slash is not a ref.
  if (trimmed.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  if (trimmed.startsWith('-')) return null;
  return trimmed;
}

/** Hosts a repository archive may be served from. */
function isGithubHost(hostname: string): boolean {
  return hostname === 'github.com' || hostname.endsWith('.github.com');
}

const bodyOf = (response: Response): AsyncIterable<Uint8Array> | null =>
  response.body
    ? (Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>,
      ) as AsyncIterable<Uint8Array>)
    : null;

const downloadArchive: ArchiveDownloader = async ({ url, token, signal }) => {
  const first = await fetch(url, {
    method: 'GET',
    headers: {
      // The token travels in a header and nowhere else — never in the path,
      // never in a log, never in an error.
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'qaai-worker',
    },
    redirect: 'manual',
    signal,
  });

  if (first.status < 300 || first.status >= 400) {
    return { ok: first.ok, status: first.status, body: first.ok ? bodyOf(first) : null };
  }

  // The redirect, followed WITHOUT the credential.
  const location = first.headers.get('location');
  if (!location) {
    return {
      ok: false,
      status: first.status,
      body: null,
      detail: 'GitHub redirected the archive download without saying where to.',
    };
  }
  let target: URL;
  try {
    target = new URL(location, url);
  } catch {
    return { ok: false, status: first.status, body: null, detail: 'The redirect was unparseable.' };
  }
  if (target.protocol !== 'https:' || !isGithubHost(target.hostname)) {
    return {
      ok: false,
      status: first.status,
      body: null,
      detail: `The archive redirect pointed at ${target.hostname}, which is not GitHub.`,
    };
  }

  const second = await fetch(target, { method: 'GET', redirect: 'follow', signal });
  return { ok: second.ok, status: second.status, body: second.ok ? bodyOf(second) : null };
};

/**
 * Fetch and extract the project's repository, or say why it could not be.
 *
 * Never throws for an expected condition — an unconnected project, an
 * unconfigured app, a 404, a cap breach and an aborted run all come back as
 * `unavailable` with a sentence, because the caller's job is to record an
 * honest SKIPPED and carry on with the rest of the suite.
 */
export async function materialiseRepoWorkspace(args: {
  runId: string;
  repo: ProjectRepoRef;
  /** The worker's vault `open`, used only to unseal the App's private key. */
  unseal: Unsealer;
  signal: AbortSignal;
  /** Both overridden only by this module's own tests. */
  download?: ArchiveDownloader;
  limits?: Partial<ExtractionLimits>;
}): Promise<RepoWorkspaceOutcome> {
  const { runId, repo, unseal, signal } = args;
  const download = args.download ?? downloadArchive;

  if (!repo.repoFullName || !repo.repoInstallationId) {
    return {
      kind: 'unavailable',
      why:
        'This project has no connected repository: install the QAAI GitHub App on the repo ' +
        '(Project settings → Repository) so QAAI can check out the code your command runs in.',
    };
  }

  let slug: string;
  try {
    slug = githubRepoSlug(repo.repoFullName);
  } catch (err) {
    return {
      kind: 'unavailable',
      why: `The project's repository "${repo.repoFullName}" is not a GitHub owner/name that QAAI will fetch (${
        err instanceof Error ? err.message : 'unparseable'
      }).`,
    };
  }

  const ref = safeRef(repo.commitSha ?? repo.defaultBranch);
  if (!ref) {
    return {
      kind: 'unavailable',
      why: `Neither this run's commit nor the project's default branch ("${repo.defaultBranch}") is a ref QAAI will put in a URL.`,
    };
  }

  let config: AppConfig | null;
  try {
    config = loadAppConfig(unseal);
  } catch (err) {
    return {
      kind: 'unavailable',
      why: `The GitHub App is half-configured, so the repository could not be checked out: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    };
  }
  if (!config) {
    return {
      kind: 'unavailable',
      why:
        'This deployment has no GitHub App configured (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY), ' +
        'and that App is how QAAI checks out a private repository.',
    };
  }

  let token: string;
  try {
    token = await installationToken(config, repo.repoInstallationId);
  } catch (err) {
    return {
      kind: 'unavailable',
      why: `GitHub would not issue a token for this repository's App installation: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    };
  }

  // One AbortSignal for the download: the run's own (a cancel stops the fetch
  // mid-stream) plus a timeout, because a stalled socket must not hold a worker.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);

  let response: Awaited<ReturnType<ArchiveDownloader>>;
  try {
    response = await download({
      url: `https://${GITHUB_API_HOST}/repos/${slug}/tarball/${ref}`,
      token,
      signal: combined,
    });
  } catch (err) {
    return {
      kind: 'unavailable',
      why: signal.aborted
        ? 'The run was cancelled while its repository was being downloaded.'
        : `GitHub could not be reached to download ${slug}@${ref}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
    };
  }

  if (!response.ok || !response.body) {
    return {
      kind: 'unavailable',
      why:
        `GitHub answered ${response.status} for ${slug}@${ref}. ` +
        (response.detail ??
          (response.status === 404
            ? 'Either the ref does not exist or the App installation no longer has access to this repository.'
            : 'Nothing was checked out, so the test was not evaluated.')),
    };
  }

  const root = await mkdtemp(join(tmpdir(), `qaai-repo-${runId.slice(-8)}-`));
  const cleanup = async (): Promise<void> => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const extracted = await extractTarGz(response.body, root, {
      // GitHub wraps a repository in one `owner-name-sha/` directory, and the
      // workspace root has to BE the repo root — otherwise every `cwd` in every
      // spec would have to know the sha.
      stripComponents: 1,
      ...(args.limits ? { limits: args.limits } : {}),
    });
    return {
      kind: 'ready',
      workspace: { root, source: `${slug}@${ref}`, fileCount: extracted.files },
      bytes: extracted.bytes,
      skippedLinks: extracted.skippedLinks,
      cleanup,
    };
  } catch (err) {
    // A partially extracted tree is worse than none: it looks like the
    // repository and is not. Remove it and report why.
    await cleanup();
    return {
      kind: 'unavailable',
      why:
        err instanceof ExtractionRefused
          ? err.message
          : `The repository archive for ${slug}@${ref} could not be unpacked: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
    };
  }
}

// ─── Extraction ──────────────────────────────────────────────────────────────

/** A cap breach or a malformed archive: the message is shown to the user. */
export class ExtractionRefused extends Error {}

export interface ExtractionResult {
  files: number;
  bytes: number;
  skippedLinks: number;
}

const BLOCK = 512;

/**
 * Read exactly `n` bytes from an async byte source, or null at a clean end.
 *
 * A tarball is a stream of 512-byte records and this is the only reason this
 * module does not simply buffer the archive: a decompression bomb must be
 * refused while it is arriving, not after it has been held in memory.
 */
class ByteReader {
  private readonly queue: Buffer[] = [];
  private held = 0;
  private finished = false;

  constructor(private readonly iterator: AsyncIterator<Uint8Array>) {}

  private async pull(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) {
      this.finished = true;
      return false;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.queue.push(chunk);
    this.held += chunk.length;
    return true;
  }

  async read(n: number): Promise<Buffer | null> {
    while (this.held < n) {
      if (this.finished) break;
      if (!(await this.pull())) break;
    }
    if (this.held === 0) return null;
    if (this.held < n) throw new ExtractionRefused('The repository archive ended mid-record.');

    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.queue[0]!;
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      this.held -= take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    return out;
  }
}

function octal(field: Buffer): number {
  // GNU base-256 for sizes that do not fit in 11 octal digits. Any file that
  // needs it is orders of magnitude past MAX_FILE_BYTES, so it is refused
  // rather than decoded.
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    throw new ExtractionRefused('The repository archive declares a file larger than QAAI will unpack.');
  }
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new ExtractionRefused('The repository archive has a malformed header.');
  }
  return value;
}

function headerName(block: Buffer): string {
  const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}

/** `path=` out of a pax extended header, which is how git archive writes long names. */
function paxPath(data: Buffer): string | null {
  let offset = 0;
  const text = data.toString('utf8');
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length).replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

/**
 * Extract a gzipped tarball into `dest`, enforcing every cap in this file.
 *
 * `stripComponents` drops leading path segments: GitHub wraps a repository in
 * one `owner-name-sha/` directory, and the workspace root has to be the repo
 * root or every `cwd` in every spec would need to know the sha.
 *
 * Exported so the extractor can be tested against a hand-built archive —
 * traversal, links, caps and long names — without a network or a `tar` binary.
 */
export async function extractTarGz(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  options: { stripComponents?: number; limits?: Partial<ExtractionLimits> } = {},
): Promise<ExtractionResult> {
  const strip = options.stripComponents ?? 0;
  const limits: ExtractionLimits = { ...DEFAULT_EXTRACTION_LIMITS, ...options.limits };

  const gunzip = createGunzip();
  const input = Readable.from(cappedBytes(source, limits.archiveBytes));
  // `pipe` does not forward errors, and the cap is raised BY the source, so it
  // has to be handed to the gunzip explicitly or it would be an unhandled
  // rejection with the extraction hanging behind it.
  input.on('error', (err) => gunzip.destroy(err));
  input.pipe(gunzip);

  const reader = new ByteReader(gunzip[Symbol.asyncIterator]());
  const result: ExtractionResult = { files: 0, bytes: 0, skippedLinks: 0 };
  /** A pax/GNU long-name header applies to the NEXT entry only. */
  let overrideName: string | null = null;
  let emptyBlocks = 0;

  try {
    for (;;) {
      const header = await reader.read(BLOCK);
      if (!header) break;

      // Two consecutive zero blocks end the archive; a single one is tolerated
      // because some writers pad oddly.
      if (header.every((byte) => byte === 0)) {
        if (++emptyBlocks >= 2) break;
        continue;
      }
      emptyBlocks = 0;

      const size = octal(header.subarray(124, 136));
      const padding = size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
      const typeFlag = String.fromCharCode(header[156] ?? 0);
      const rawName = overrideName ?? headerName(header);
      overrideName = null;

      // Long-name and extended headers: the name for the next entry lives in
      // this entry's data.
      if (typeFlag === 'L' || typeFlag === 'x' || typeFlag === 'X') {
        const data = await readExactly(reader, size);
        const name =
          typeFlag === 'L' ? data.toString('utf8').replace(/\0.*$/, '') : paxPath(data);
        if (name) overrideName = name;
        await skip(reader, padding);
        continue;
      }
      // A global pax header or a long LINK name: nothing here wants either.
      if (typeFlag === 'g' || typeFlag === 'K') {
        await skip(reader, size + padding);
        continue;
      }

      // Links are never created. See the header: this is the extraction escape.
      if (typeFlag === '1' || typeFlag === '2') {
        result.skippedLinks += 1;
        await skip(reader, size + padding);
        continue;
      }

      // Anything that is not a regular file or a directory — a device, a FIFO,
      // a contiguous file — has no business in a source tree.
      if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '7' && typeFlag !== '5') {
        await skip(reader, size + padding);
        continue;
      }

      const stripped = rawName
        .replace(/\\/g, '/')
        .split('/')
        .slice(strip)
        .join('/')
        .replace(/\/+$/, '');

      if (!stripped) {
        await skip(reader, size + padding);
        continue;
      }

      const target = resolveInsideWorkspace(dest, stripped);
      if (!target) {
        /*
         * An entry whose path climbs out of the workspace is not a mistake a
         * normal archive makes: `git archive` cannot produce one. Refusing the
         * whole archive — rather than skipping the entry — is the right answer
         * for the same reason a partial extraction is removed above: whatever
         * this tarball is, it is not a repository QAAI should be running
         * somebody's command inside.
         */
        throw new ExtractionRefused(
          `The repository archive contains an entry (${stripped}) whose path escapes the workspace; nothing was checked out.`,
        );
      }

      if (typeFlag === '5') {
        // Created only so an EMPTY directory survives; files make their own
        // parents below.
        await mkdir(target, { recursive: true });
        await skip(reader, size + padding);
        continue;
      }

      if (size > limits.fileBytes) {
        throw new ExtractionRefused(
          `The repository contains ${stripped} at ${size} bytes, over QAAI's per-file limit of ${limits.fileBytes}, so nothing was checked out.`,
        );
      }
      if (result.bytes + size > limits.workspaceBytes) {
        throw new ExtractionRefused(
          `The repository expands past QAAI's workspace limit of ${limits.workspaceBytes} bytes, so nothing was checked out.`,
        );
      }
      if (result.files + 1 > limits.files) {
        throw new ExtractionRefused(
          `The repository holds more files than QAAI's limit of ${limits.files}, so nothing was checked out.`,
        );
      }

      await mkdir(dirname(target), { recursive: true });
      /*
       * The executable bit is carried over and nothing else is. A build that
       * runs `./gradlew` or `./scripts/test.sh` needs it; setuid, setgid and
       * group/other write bits are dropped, because a tarball is the last place
       * a worker should take those from.
       */
      const mode = (octal(header.subarray(100, 108)) & 0o111) !== 0 ? 0o700 : 0o600;
      const handle = await openFile(target, 'w', mode);
      try {
        let remaining = size;
        while (remaining > 0) {
          const take = Math.min(remaining, 1024 * 1024);
          const chunk = await readExactly(reader, take);
          await handle.write(chunk);
          remaining -= take;
        }
      } finally {
        await handle.close();
      }
      result.files += 1;
      result.bytes += size;
      await skip(reader, padding);
    }
  } finally {
    input.destroy();
    gunzip.destroy();
  }

  return result;
}

async function readExactly(reader: ByteReader, n: number): Promise<Buffer> {
  if (n === 0) return Buffer.alloc(0);
  const chunk = await reader.read(n);
  if (!chunk) throw new ExtractionRefused('The repository archive ended mid-file.');
  return chunk;
}

async function skip(reader: ByteReader, n: number): Promise<void> {
  let remaining = n;
  while (remaining > 0) {
    const take = Math.min(remaining, 1024 * 1024);
    if (!(await reader.read(take))) return;
    remaining -= take;
  }
}

/** Raises {@link ExtractionRefused} the moment the archive passes `max` bytes. */
async function* cappedBytes(
  source: AsyncIterable<Uint8Array>,
  max: number,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.byteLength;
    if (seen > max) {
      throw new ExtractionRefused(
        `The repository archive is larger than QAAI's download limit of ${max} bytes, so nothing was checked out.`,
      );
    }
    yield chunk;
  }
}
