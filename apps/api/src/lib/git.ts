/**
 * Push a materialised repo to a customer's git remote.
 *
 * isomorphic-git rather than shelling out to `git`: no git binary has to exist
 * in the container, HTTPS+token auth works identically across GitHub, GitLab and
 * Bitbucket, and — the reason that matters most — the token is supplied through
 * an `onAuth` callback instead of being interpolated into a remote URL. A
 * `git push https://<token>@host/...` would leak the credential into process
 * listings, shell history and git's own logs; this cannot.
 *
 * The push is always to an explicit branch and never forced, so it can add to a
 * customer's repo but not rewrite its history.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import fs from 'node:fs';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type { GitIntegrationKind } from '@qaai/shared';
import type { RepoTree } from './repo-export.js';

/**
 * The username each provider expects alongside a personal access token. The
 * token is the password in every case; only this literal differs.
 */
const TOKEN_USERNAME: Record<GitIntegrationKind, string> = {
  GITHUB: 'x-access-token',
  GITLAB: 'oauth2',
  BITBUCKET: 'x-token-auth',
};

const HOST: Record<GitIntegrationKind, string> = {
  GITHUB: 'github.com',
  GITLAB: 'gitlab.com',
  BITBUCKET: 'bitbucket.org',
};

/**
 * `owner/repo` → the provider's https clone URL.
 *
 * A full https URL is allowed but its host is pinned to the provider. This is
 * load-bearing security, not tidiness: isomorphic-git sends an unauthenticated
 * `/info/refs` first and retries with `Authorization: Basic <user:PAT>` on a 401,
 * so any host that answers 401 would be handed the plaintext token. Resolving the
 * URL therefore has to fail *before* the token is ever decrypted.
 */
export function repoHttpsUrl(kind: GitIntegrationKind, repo: string): string {
  if (/^https:\/\//.test(repo)) {
    let url: URL;
    try {
      url = new URL(repo);
    } catch {
      throw new Error('Not a valid repository URL');
    }
    if (url.hostname !== HOST[kind]) {
      throw new Error(
        `Refusing to push to ${url.hostname}: a ${kind} integration may only push to ${HOST[kind]}`,
      );
    }
    if (url.username || url.password) {
      throw new Error('Remove the credentials from the repository URL — the token is stored separately');
    }
    return `https://${url.host}${url.pathname.replace(/\.git$/, '')}.git`;
  }
  return `https://${HOST[kind]}/${repo.replace(/\.git$/, '')}.git`;
}

export interface PushOptions {
  kind: GitIntegrationKind;
  repo: string;
  /** Plaintext PAT. Held only for the duration of this call. */
  token: string;
  branch: string;
  message: string;
  authorName: string;
  authorEmail: string;
}

export interface PushResult {
  commitSha: string;
  branch: string;
  /** The repo URL, with no credential in it — safe to show and to log. */
  repoUrl: string;
  fileCount: number;
}

/** Guard: a tree path must stay inside the workspace. */
function safeJoin(root: string, relPath: string): string {
  const full = resolve(join(root, relPath));
  if (!full.startsWith(resolve(root) + sep)) {
    throw new Error(`Refusing to write outside the repo workspace: ${relPath}`);
  }
  return full;
}

/**
 * Fetch the remote branch (when it exists) so the commit builds on top of it,
 * then commit the tree and push. Returns without a network write on failure —
 * callers surface a message that never contains the token.
 */
export async function pushRepo(tree: RepoTree, opts: PushOptions): Promise<PushResult> {
  const url = repoHttpsUrl(opts.kind, opts.repo);
  const dir = await mkdtemp(join(tmpdir(), 'qaai-push-'));

  // The token never touches the URL, argv, or disk — only this callback.
  const onAuth = () => ({ username: TOKEN_USERNAME[opts.kind], password: opts.token });

  try {
    await git.init({ fs, dir, defaultBranch: opts.branch });
    await git.addRemote({ fs, dir, remote: 'origin', url });

    // Start from the remote branch when it already exists, so a push adds a
    // commit rather than being rejected as a non-fast-forward.
    let basedOnRemote = false;
    try {
      await git.fetch({
        fs,
        http,
        dir,
        remote: 'origin',
        ref: opts.branch,
        depth: 1,
        singleBranch: true,
        onAuth,
      });
      await git.checkout({ fs, dir, ref: opts.branch, force: true });
      basedOnRemote = true;
    } catch {
      // No such branch yet (or an empty repo) — this becomes the first commit.
    }

    for (const [relPath, content] of tree) {
      const target = safeJoin(dir, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      await git.add({ fs, dir, filepath: relPath });
    }

    // Delete what QAAI no longer has. Without this the branch would accumulate
    // remote-files ∪ tree, so a test deleted in QAAI would linger in the repo
    // forever and keep running in the customer's CI.
    if (basedOnRemote) {
      const tracked = await git.listFiles({ fs, dir, ref: 'HEAD' }).catch(() => [] as string[]);
      for (const relPath of tracked) {
        if (tree.has(relPath)) continue;
        await git.remove({ fs, dir, filepath: relPath });
        await rm(safeJoin(dir, relPath), { force: true }).catch(() => {});
      }
    }

    const commitSha = await git.commit({
      fs,
      dir,
      message: opts.message,
      author: { name: opts.authorName, email: opts.authorEmail },
    });

    await git.push({
      fs,
      http,
      dir,
      remote: 'origin',
      ref: opts.branch,
      remoteRef: opts.branch,
      // Never force: QAAI may add to a customer's repo, never rewrite it.
      force: false,
      onAuth,
    });

    return { commitSha, branch: opts.branch, repoUrl: url, fileCount: tree.size };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
