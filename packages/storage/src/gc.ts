/**
 * Storage garbage collection (§5 retention) — enumerate, measure, and delete
 * artifacts BY EXACT KEY.
 *
 * `Storage` (index.ts) is the write path: it puts bytes and signs URLs. The one
 * destructive thing it can do is `deletePrefix`, and that is precisely the wrong
 * tool for retention. A prefix delete is unbounded by construction — on the
 * local backend it is `rm -rf` on a directory, on S3 it pages the whole listing
 * — so a key that arrives one segment short (`org/<orgId>/run/` instead of
 * `org/<orgId>/run/<runId>/`) takes an org's entire history with it, and there
 * is nothing to undo it with. Nothing in this file accepts a prefix as a
 * deletion target. `deleteObjects` takes the exact keys and only those.
 *
 * ── Absent is not the same as broken ────────────────────────────────────────
 *
 * `stat` returns `null` for an object that genuinely is not there, and throws
 * for a backend that could not answer. Collapsing those two into `null` is the
 * single worst bug this module could ship: during an S3 outage every object
 * would read as "already gone", and a sweeper that deletes rows whose objects
 * are missing would delete every artifact row in the database while every byte
 * survived in the bucket — an unfindable bill and a cockpit full of dead links,
 * in one pass, with no way back. So the classification below defaults to
 * "backend failure" for anything it does not positively recognise as a 404.
 *
 * ── Two kinds of error, two different responses ─────────────────────────────
 *
 *   `scope: 'object'`  — this one key is strange (a directory sitting where a
 *                        file should be). The caller may skip that artifact and
 *                        carry on; it must not delete it.
 *   `scope: 'backend'` — the store itself is unhappy (auth, network, 5xx). The
 *                        caller must STOP. Continuing means deleting rows whose
 *                        objects may well have survived.
 *
 * One key being weird should not wedge retention for the whole fleet; the bucket
 * being unreachable absolutely should.
 *
 * ── Key namespaces, and the one-character difference that matters ───────────
 *
 *   `org/<orgId>/run/<runId>/<name>`   run artifacts — an Artifact row each
 *   `orgs/<orgId>/persistent/<name>`   visual baselines — NO Artifact row, ever
 *
 * Singular `org/` versus plural `orgs/`. Because `orgs/` does not start with
 * `org/`, a prefix listing of the run namespace cannot see a baseline, which is
 * the only reason `deletePrefix('org/<id>/')` has never eaten anyone's
 * baselines. Do not "fix" the inconsistency without reading retention.ts first.
 * A baseline is a row-less object on purpose, so any orphan scan that treats
 * "object with no row" as garbage would delete every visual baseline in the
 * install. `classifyStrayKey` exists so that cannot happen by accident.
 */

import { readdir, stat as fsStat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from './index.js';

/**
 * S3 caps a DeleteObjects request at 1000 keys. Chunking is not optional — a
 * 1001-key request is rejected wholesale, which would look like "the sweep can
 * never delete anything" the first time a batch got big.
 */
export const MAX_DELETE_BATCH = 1000;

/** S3's own ceiling on one ListObjectsV2 page. */
export const MAX_LIST_PAGE = 1000;

export interface StoredObject {
  key: string;
  sizeBytes: number;
  /** Null when the backend does not report one; never invented. */
  lastModified: Date | null;
}

export interface ObjectPage {
  objects: StoredObject[];
  /** Opaque. Pass back to resume; null means the listing is exhausted. */
  cursor: string | null;
}

export interface DeleteFailure {
  key: string;
  reason: string;
}

export interface DeleteOutcome {
  /** Keys the backend confirmed are gone. Only these rows may be deleted. */
  deleted: string[];
  /** Keys that survived, or whose fate is unknown. Their rows must be kept. */
  failed: DeleteFailure[];
}

/**
 * A failure with a blast radius attached.
 *
 * `scope` is the contract with the caller: 'object' means "skip this key",
 * 'backend' means "stop everything". Anything constructed without a deliberate
 * scope is 'backend', because the safe default is to stop.
 */
export class StorageGcError extends Error {
  constructor(
    message: string,
    readonly scope: 'object' | 'backend',
    readonly key: string | null,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageGcError';
  }
}

export interface StorageGc {
  /**
   * One bounded page of objects under `prefix`. An empty prefix lists the whole
   * bucket, which is what the both-ways orphan scan needs.
   */
  list(prefix: string, opts?: { cursor?: string | null; limit?: number }): Promise<ObjectPage>;
  /** The object, or null if it genuinely is not there. Throws if unsure. */
  stat(key: string): Promise<StoredObject | null>;
  /** Deletes exactly these keys. Never a prefix, never a directory. */
  deleteObjects(keys: readonly string[]): Promise<DeleteOutcome>;
}

// ─── Key namespaces ──────────────────────────────────────────────────────────

/** Everything a retention sweep is allowed to consider, for one org. */
export function runArtifactPrefix(orgId: string): string {
  return `org/${orgId}/run/`;
}

/** Objects that deliberately outlive their run and have no Artifact row. */
export function persistentPrefix(orgId: string): string {
  return `orgs/${orgId}/persistent/`;
}

/** The prefix covering every run artifact in the install. */
export const ALL_RUN_ARTIFACTS_PREFIX = 'org/';

export interface ParsedArtifactKey {
  orgId: string;
  runId: string;
  name: string;
}

/**
 * Reads a run-artifact key back into its parts, or null if the key is not one.
 *
 * Strict on purpose: exactly five segments, exactly the `org`/`run` literals,
 * and no empty segment. `artifactKey()` sanitises `name` to `[A-Za-z0-9._-]`, so
 * a real key never contains a sixth slash — and a key that does is not something
 * this module should be confident enough about to hand to a deletion routine.
 */
export function parseRunArtifactKey(key: string): ParsedArtifactKey | null {
  const parts = key.split('/');
  if (parts.length !== 5) return null;
  const [org, orgId, run, runId, name] = parts;
  if (org !== 'org' || run !== 'run') return null;
  if (!orgId || !runId || !name) return null;
  return { orgId, runId, name };
}

export type StrayKind =
  /** A visual baseline. Row-less by design — reporting it as garbage is a bug. */
  | 'persistent'
  /** Shaped like a run artifact but no Artifact row points at it. */
  | 'run-artifact'
  /** Not in any namespace this code writes. Someone else's object, or ours from
   *  a version that no longer exists. Never assume. */
  | 'unknown';

/**
 * What kind of thing an object with no database row is.
 *
 * This is the whole reason the stray-object report is safe to look at: the
 * answer is never "garbage". `persistent` is expected and correct, `unknown` is
 * a question for a human, and even `run-artifact` — the one case that really
 * does look like leaked storage — is only ever reported. Nothing in this
 * codebase deletes an object because no row mentions it, because the row may
 * simply not have been written yet: the worker uploads bytes first and upserts
 * the Artifact row afterwards, so every in-flight run has objects that are
 * momentarily row-less.
 */
export function classifyStrayKey(key: string): StrayKind {
  if (/^orgs\/[^/]+\/persistent\//.test(key)) return 'persistent';
  if (parseRunArtifactKey(key)) return 'run-artifact';
  return 'unknown';
}

// ─── S3 ──────────────────────────────────────────────────────────────────────

function httpStatusOf(err: unknown): number | null {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : null;
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/**
 * Is this S3 error "the object is not there", or "I could not tell you"?
 *
 * Only a 404 and the two names the SDK uses for it count as absence. Notably
 * 403 does NOT: a bucket policy that denies `s3:GetObject` answers AccessDenied
 * for a key that exists, and treating that as absence would delete the rows for
 * an entire bucket we simply lost read permission on.
 */
function isS3NotFound(err: unknown): boolean {
  const name = nameOf(err);
  return name === 'NotFound' || name === 'NoSuchKey' || httpStatusOf(err) === 404;
}

class S3Gc implements StorageGc {
  private readonly client: S3Client;

  constructor(private readonly cfg: StorageConfig) {
    this.client = new S3Client({
      region: cfg.region ?? 'us-east-1',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? true,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    });
  }

  async list(prefix: string, opts: { cursor?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? MAX_LIST_PAGE), MAX_LIST_PAGE);
    let res;
    try {
      res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          MaxKeys: limit,
          ContinuationToken: opts.cursor ?? undefined,
        }),
      );
    } catch (err) {
      throw new StorageGcError(`Could not list ${prefix}: ${nameOf(err)}`, 'backend', null, err);
    }

    const objects: StoredObject[] = [];
    for (const o of res.Contents ?? []) {
      if (!o.Key) continue;
      objects.push({
        key: o.Key,
        sizeBytes: typeof o.Size === 'number' ? o.Size : 0,
        lastModified: o.LastModified ?? null,
      });
    }
    // IsTruncated, not "did we fill the page": a page can come back short and
    // still have more behind it, and stopping there silently under-reports.
    return { objects, cursor: res.IsTruncated ? (res.NextContinuationToken ?? null) : null };
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return {
        key,
        sizeBytes: typeof res.ContentLength === 'number' ? res.ContentLength : 0,
        lastModified: res.LastModified ?? null,
      };
    } catch (err) {
      if (isS3NotFound(err)) return null;
      throw new StorageGcError(
        `Could not stat ${key}: ${nameOf(err)} (${httpStatusOf(err) ?? 'no status'})`,
        'backend',
        key,
        err,
      );
    }
  }

  async deleteObjects(keys: readonly string[]): Promise<DeleteOutcome> {
    const outcome: DeleteOutcome = { deleted: [], failed: [] };
    if (keys.length === 0) return outcome;

    for (let i = 0; i < keys.length; i += MAX_DELETE_BATCH) {
      const chunk = keys.slice(i, i + MAX_DELETE_BATCH);
      let res;
      try {
        res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.cfg.bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: false },
          }),
        );
      } catch (err) {
        /*
         * The request itself failed, so we do not know what S3 did with it — a
         * socket that died after the server processed the delete looks exactly
         * like one that died before. Every key in this chunk is reported as
         * failed so the caller keeps their rows.
         *
         * That is the deliberate choice: a row pointing at a deleted object is a
         * 404 in the cockpit, which is recoverable. A deleted row pointing at a
         * live object is a bill nobody can trace back to a customer, which is
         * not.
         */
        const reason = `delete request failed: ${nameOf(err)}`;
        for (const key of chunk) outcome.failed.push({ key, reason });
        return outcome;
      }

      // S3 reports a delete of a key that was never there as a success. That is
      // the behaviour we want — retention must be idempotent, because a sweep
      // that crashed after deleting objects and before deleting rows has to be
      // able to run again.
      for (const d of res.Deleted ?? []) if (d.Key) outcome.deleted.push(d.Key);
      for (const e of res.Errors ?? []) {
        if (!e.Key) continue;
        outcome.failed.push({ key: e.Key, reason: `${e.Code ?? 'Error'}: ${e.Message ?? ''}`.trim() });
      }

      // A key we asked about that came back in neither list is unaccounted for.
      // Reported as failed rather than assumed deleted.
      const accounted = new Set([...outcome.deleted, ...outcome.failed.map((f) => f.key)]);
      for (const key of chunk) {
        if (!accounted.has(key)) {
          outcome.failed.push({ key, reason: 'the backend did not report on this key' });
        }
      }
    }

    return outcome;
  }
}

// ─── Local disk ──────────────────────────────────────────────────────────────

function errnoOf(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? '';
}

class LocalGc implements StorageGc {
  private readonly root: string;

  constructor(cfg: StorageConfig) {
    this.root = resolve(cfg.rootDir ?? '.artifacts');
  }

  /**
   * Resolve a key under the root, or refuse.
   *
   * Duplicated from LocalStorage rather than shared, because this copy guards
   * deletion and the other guards writes — and a containment check that two
   * call sites share is a containment check that can be relaxed for one of them
   * by someone who only had the other in mind. `..` in a key must never reach
   * `unlink`.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new StorageGcError(`Artifact key escapes storage root: ${key}`, 'object', key);
    }
    return full;
  }

  /**
   * Depth-first walk yielding storage keys in a stable order.
   *
   * Sorted at every level so the sequence is identical across calls, which is
   * what makes the cursor below mean anything: a listing that reorders itself
   * between pages skips objects, and an orphan scan that skips objects reports
   * fiction.
   *
   * Symlinks are skipped — a dirent that is neither a file nor a directory
   * falls through both branches. Following one would let a link planted under
   * `.artifacts` make this walk report (and, one refactor later, delete) paths
   * anywhere on the disk.
   */
  private async *walk(dir: string, keyPrefix: string): AsyncGenerator<StoredObject> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A missing directory is an empty one: a fresh install has no .artifacts,
      // and a concurrent retention pass may have just removed a run's folder.
      if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR') return;
      throw new StorageGcError(`Could not read ${dir}: ${nameOf(err)}`, 'backend', null, err);
    }

    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childKey = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield* this.walk(join(dir, entry.name), childKey);
      } else if (entry.isFile()) {
        try {
          const s = await fsStat(join(dir, entry.name));
          yield { key: childKey, sizeBytes: s.size, lastModified: s.mtime };
        } catch (err) {
          if (errnoOf(err) === 'ENOENT') continue;
          throw new StorageGcError(
            `Could not stat ${childKey}: ${nameOf(err)}`,
            'backend',
            childKey,
            err,
          );
        }
      }
    }
  }

  /**
   * `cursor` is the last key of the previous page and resumption re-walks from
   * the top, skipping until past it. That is O(n) per page where S3 is O(1), and
   * it is fine: this backend exists for `npm run dev` without Docker, where n is
   * a few hundred files. Holding the whole listing in memory to avoid the
   * re-walk would be the worse trade — that is the shape that falls over on the
   * one install where somebody points ARTIFACTS_LOCAL at a real disk.
   */
  async list(prefix: string, opts: { cursor?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(1, opts.limit ?? MAX_LIST_PAGE), MAX_LIST_PAGE);
    const after = opts.cursor ?? null;
    const objects: StoredObject[] = [];
    let more = false;

    for await (const obj of this.walk(this.root, '')) {
      if (after !== null && obj.key <= after) continue;
      if (!obj.key.startsWith(prefix)) continue;
      if (objects.length === limit) {
        more = true;
        break;
      }
      objects.push(obj);
    }

    const last = objects[objects.length - 1];
    return { objects, cursor: more && last ? last.key : null };
  }

  async stat(key: string): Promise<StoredObject | null> {
    let path;
    try {
      path = this.pathFor(key);
    } catch (err) {
      if (err instanceof StorageGcError) throw err;
      throw new StorageGcError(`Bad key ${key}: ${nameOf(err)}`, 'object', key, err);
    }

    try {
      const s = await fsStat(path);
      if (s.isDirectory()) {
        // A directory where an object should be. Not absence — something is
        // wrong with this key, and answering `null` would invite the caller to
        // delete a row whose bytes are demonstrably still here. Object-scoped so
        // one bad key does not wedge the whole sweep.
        throw new StorageGcError(`${key} is a directory, not an object`, 'object', key);
      }
      return { key, sizeBytes: s.size, lastModified: s.mtime };
    } catch (err) {
      if (err instanceof StorageGcError) throw err;
      if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR') return null;
      // EACCES, EIO, EMFILE — the disk or the process is unhappy, not this key.
      throw new StorageGcError(`Could not stat ${key}: ${nameOf(err)}`, 'backend', key, err);
    }
  }

  async deleteObjects(keys: readonly string[]): Promise<DeleteOutcome> {
    const outcome: DeleteOutcome = { deleted: [], failed: [] };
    for (const key of keys) {
      try {
        // `unlink`, never `rm`: unlink cannot recurse. `rm` grew a `recursive`
        // option, and the day someone passes it a run prefix "to clean up
        // properly" is the day this deletes a directory tree.
        await unlink(this.pathFor(key));
        outcome.deleted.push(key);
      } catch (err) {
        // Already gone counts as deleted, so a sweep that died between deleting
        // objects and deleting rows can finish the job on its next pass.
        if (errnoOf(err) === 'ENOENT') {
          outcome.deleted.push(key);
          continue;
        }
        outcome.failed.push({ key, reason: `${errnoOf(err) || nameOf(err)}` });
      }
    }
    return outcome;
  }
}

/**
 * Build the GC handle from the same config `createStorage` takes, so the sweeper
 * cannot end up pointed at a different bucket than the writer.
 */
export function createStorageGc(cfg: StorageConfig): StorageGc {
  return cfg.backend === 'local' ? new LocalGc(cfg) : new S3Gc(cfg);
}

// ─── The retention policy ────────────────────────────────────────────────────

/**
 * WHY THE POLICY LIVES HERE and not in the worker that runs it.
 *
 * Two callers need to agree about it exactly: the worker's sweep, which
 * deletes, and the API's `/retention/preview`, which tells an operator what the
 * sweep is about to delete. A preview computed by a second implementation is
 * worse than no preview at all — it is a number somebody reads, believes, and
 * enables destruction on the strength of. `packages/storage` is the only module
 * both apps already depend on, so the predicate lives here and both import it.
 *
 * It is pure: no Prisma, no S3, no clock of its own. Everything it needs is on
 * the candidate or in the context, which is what makes it testable and what
 * makes a preview and a sweep provably the same decision.
 */

export type KeepReason =
  | 'no-expiry-stamped'
  | 'not-yet-expired'
  | 'within-grace-period'
  | 'run-not-terminal'
  | 'run-not-finished'
  | 'plan-window-still-open'
  | 'triage-active'
  | 'visual-baseline'
  | 'key-unparseable'
  | 'key-mismatch';

export interface ArtifactCandidate {
  id: string;
  orgId: string;
  runId: string;
  key: string;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date | null;
  runStatus: string;
  runFinishedAt: Date | null;
  /** Longest retention any plan record gives this org, in days. */
  orgRetentionDays: number;
  triageActive: boolean;
  usedAsVisualBaseline: boolean;
}

export interface PolicyContext {
  now: Date;
  graceMs: number;
  /**
   * Supplied by the caller as `TERMINAL_RUN_STATUSES` from @qaai/shared.
   *
   * Injected rather than imported so this package keeps its empty dependency
   * list, and — more to the point — so there is never a second hand-written copy
   * of the run-status enum to fall out of date with the schema. A stale copy
   * here would misread a terminal status as "still running" (harmless) or, far
   * worse, a running one as terminal.
   */
  terminalStatuses: readonly string[];
}

export type SweepVerdict = { delete: true } | { delete: false; reason: KeepReason; detail: string };

const KEEP = (reason: KeepReason, detail: string): SweepVerdict => ({
  delete: false,
  reason,
  detail,
});

/**
 * May this one artifact be deleted?
 *
 * Ordered cheapest-and-most-decisive first, and every branch returns a sentence
 * an operator can read in the report. "3,412 kept" is not auditable; "3,412
 * kept: 2,900 run-not-finished, 512 triage-active" is.
 */
export function decideArtifact(c: ArtifactCandidate, ctx: PolicyContext): SweepVerdict {
  if (c.expiresAt === null) {
    return KEEP('no-expiry-stamped', 'no expiresAt was ever stamped on this row');
  }

  const now = ctx.now.getTime();
  const expires = c.expiresAt.getTime();
  if (expires > now) {
    return KEEP('not-yet-expired', `expires ${c.expiresAt.toISOString()}`);
  }
  // `>=`, so an artifact sitting exactly on the boundary is kept and only one
  // strictly past it is deleted. The same convention flake.ts uses for its
  // quarantine threshold, and for the same reason: on a boundary, the direction
  // that does nothing is the one to take.
  if (expires >= now - ctx.graceMs) {
    return KEEP(
      'within-grace-period',
      `expired ${c.expiresAt.toISOString()}, inside the ${Math.round(ctx.graceMs / 3_600_000)}h grace period`,
    );
  }

  if (!ctx.terminalStatuses.includes(c.runStatus)) {
    // The run is still executing and may still be uploading. Note this can only
    // happen to an artifact whose expiry has already passed, i.e. a run that has
    // been "running" for longer than the org's whole retention window — which is
    // a stuck run, and a stuck run is a thing to investigate, not to delete.
    return KEEP('run-not-terminal', `run ${c.runId} is ${c.runStatus}`);
  }
  if (c.runFinishedAt === null) {
    return KEEP('run-not-finished', `run ${c.runId} is ${c.runStatus} but has no finishedAt`);
  }

  /*
   * Honour the org's CURRENT plan as well as the stamp on the row.
   *
   * `expiresAt` records the plan the org was on when the artifact was written. A
   * team that upgrades FREE → BUSINESS is paying for 90 days and would otherwise
   * watch last week's evidence disappear on the old 7-day stamp. Taking the
   * later of the two fixes that, and it errs the same way on a downgrade: an org
   * that drops to FREE keeps its old artifacts to their original expiry instead
   * of having 358 days of history deleted the hour the plan changed. Both
   * directions cost storage and neither destroys anything, which is the trade
   * this policy is supposed to make.
   */
  const planExpiry = c.createdAt.getTime() + c.orgRetentionDays * 86_400_000;
  if (planExpiry >= now - ctx.graceMs) {
    return KEEP(
      'plan-window-still-open',
      `the org's current ${c.orgRetentionDays}-day window keeps this until ${new Date(planExpiry).toISOString()}`,
    );
  }

  if (c.triageActive) {
    return KEEP('triage-active', `run ${c.runId} has triage still open on it`);
  }

  if (c.usedAsVisualBaseline) {
    return KEEP('visual-baseline', 'a VisualBaseline points at this key');
  }

  /*
   * The key has to be one this codebase wrote, and it has to agree with the row.
   *
   * A row and a key that disagree about which org or run they belong to means
   * one of the two is wrong, and there is no way to tell which from here. The
   * only safe move is to touch neither and let a human look — the alternative is
   * deleting another tenant's object because a row said so.
   */
  const parsed = parseRunArtifactKey(c.key);
  if (!parsed) {
    return KEEP('key-unparseable', `"${c.key}" is not a run-artifact key`);
  }
  if (parsed.orgId !== c.orgId || parsed.runId !== c.runId) {
    return KEEP(
      'key-mismatch',
      `key says org=${parsed.orgId} run=${parsed.runId}, row says org=${c.orgId} run=${c.runId}`,
    );
  }

  return { delete: true };
}

// ─── Reporting helpers ───────────────────────────────────────────────────────

/** Bytes as something a human reads in an operator report. Base 10, like a bill. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
