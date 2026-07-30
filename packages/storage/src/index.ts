/**
 * Artifact storage (§5) — screenshots, videos, traces, k6 output.
 *
 * Two backends behind one interface:
 *  - `s3`    — any S3-compatible endpoint; MinIO in docker-compose.
 *  - `local` — a directory on disk, for `npm run dev` without Docker.
 *
 * Keys are namespaced `org/<orgId>/run/<runId>/<name>` so retention sweeps and
 * per-tenant deletion are a prefix operation rather than a table scan.
 */

import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StorageConfig {
  backend: 's3' | 'local';
  bucket: string;
  /** Only for `local`. */
  rootDir?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Base URL the browser can reach for local-backend artifacts. */
  localPublicBaseUrl?: string;
}

export interface Storage {
  put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void>;
  putFile(key: string, absolutePath: string, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** A URL the cockpit can put in an <img>/<video> src. Expires. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  deletePrefix(prefix: string): Promise<number>;
}

/**
 * Where the local backend keeps artifacts.
 *
 * Derived from this file's own location rather than `process.cwd()`, because
 * the API and the worker run from different working directories. Resolving it
 * per-process meant the worker wrote to the repo root and the API looked under
 * `apps/api` — every screenshot 500'd.
 */
export function defaultLocalArtifactRoot(): string {
  // packages/storage/src/index.ts → up four levels is the repo root.
  return fileURLToPath(new URL('../../../.artifacts', import.meta.url));
}

export function artifactKey(parts: { orgId: string; runId: string; name: string }): string {
  const safeName = parts.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `org/${parts.orgId}/run/${parts.runId}/${safeName}`;
}

// ─── S3 ──────────────────────────────────────────────────────────────────────

class S3Storage implements Storage {
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

  async put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async putFile(key: string, absolutePath: string, contentType: string): Promise<void> {
    // Streamed rather than buffered: traces and videos routinely exceed 100MB.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: createReadStream(absolutePath),
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Artifact ${key} has no body`);
    return Buffer.from(bytes);
  }

  async signedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }),
        );
        deleted += keys.length;
      }
      token = listed.NextContinuationToken;
    } while (token);
    return deleted;
  }
}

// ─── Local disk ──────────────────────────────────────────────────────────────

class LocalStorage implements Storage {
  private readonly root: string;

  constructor(private readonly cfg: StorageConfig) {
    this.root = resolve(cfg.rootDir ?? '.artifacts');
  }

  /**
   * Keys come from run/test names that ultimately trace back to user input, so
   * every path is resolved and re-checked against the root before any write.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Artifact key escapes storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Buffer | Uint8Array, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async putFile(key: string, absolutePath: string, _contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(absolutePath, path);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async signedUrl(key: string): Promise<string> {
    // No signature locally — the API serves these behind the normal session check.
    const base = this.cfg.localPublicBaseUrl ?? '';
    return `${base}/artifacts/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const path = this.pathFor(prefix);
    await rm(path, { recursive: true, force: true });
    return 1;
  }
}

export function createStorage(cfg: StorageConfig): Storage {
  return cfg.backend === 'local' ? new LocalStorage(cfg) : new S3Storage(cfg);
}
