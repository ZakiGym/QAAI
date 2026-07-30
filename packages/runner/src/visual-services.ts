/**
 * Managed visual-diff services (§6) — Applitools, Percy, Chromatic.
 *
 * QAAI does visual regression itself (see plugins/visual.ts) and that stays the
 * default: a visual test should not need a second vendor and a second bill. But
 * a team already paying for Applitools has baselines, reviewers and an approval
 * history there, and telling them to abandon it is not a migration path. When a
 * visual integration is enabled, QAAI sends the snapshot to it and reports the
 * vendor's verdict.
 *
 * **These shell out to each vendor's own CLI rather than calling their REST
 * APIs.** That is a deliberate trade. A hand-rolled client for three separate
 * upload/build/finalize protocols is code we cannot verify without three paid
 * accounts, and which silently rots every time a vendor revises an endpoint.
 * The CLIs are maintained by the vendor, are the supported integration path,
 * and are what their own docs tell you to run in CI. It is the same reasoning
 * that makes the Playwright harness invoke the real `playwright` binary instead
 * of reimplementing its runner.
 *
 * The consequence is that the CLI has to be installed, and the honest handling
 * of a missing one is to SKIP with an install command — not to fail the test.
 * A missing tool is a configuration gap, and reporting it as a visual
 * regression would be a lie about the application under test.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { VisualIntegrationKind } from '@qaai/shared';

export interface VisualServiceResult {
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  message: string;
  /** Where a human reviews and approves the diff, when the CLI reports one. */
  reviewUrl: string | null;
}

interface Vendor {
  /**
   * The binary in `node_modules/.bin`, resolved directly rather than through
   * `npx`.
   *
   * Going through npx looked convenient and was wrong twice over. It hides a
   * missing dependency behind npx's own exit 1 — so an uninstalled CLI reported
   * as a *visual regression*, blaming the application for a missing devDep —
   * and on a machine with a network it will happily go and install a package
   * mid-test-run, which is not a thing a test should do.
   */
  bin: string;
  /** Everything after the binary; never a shell string — see `shell: false`. */
  args: (input: { snapshotDir: string; buildName: string }) => string[];
  /** Vault secret holding the vendor's token, and the env var it expects. */
  secretName: string;
  envVar: string;
  installHint: string;
  /** Pulls the review URL out of CLI output, which is how all three report it. */
  reviewUrlPattern: RegExp;
}

/**
 * One entry per vendor.
 *
 * The token is passed through the environment, never on the argv. Process
 * arguments are world-readable on Linux (`/proc/<pid>/cmdline`) and land in
 * shell history and CI logs; the environment is at least not casually visible
 * to every other process on the box.
 */
const VENDORS: Record<VisualIntegrationKind, Vendor> = {
  PERCY: {
    bin: 'percy',
    args: ({ snapshotDir }) => ['upload', snapshotDir],
    secretName: 'PERCY_TOKEN',
    envVar: 'PERCY_TOKEN',
    installHint: 'npm i -D @percy/cli',
    reviewUrlPattern: /(https:\/\/percy\.io\/\S+)/,
  },
  APPLITOOLS: {
    bin: 'eyes-storybook',
    args: ({ snapshotDir, buildName }) => ['--conf', snapshotDir, '--build-name', buildName],
    secretName: 'APPLITOOLS_API_KEY',
    envVar: 'APPLITOOLS_API_KEY',
    installHint: 'npm i -D @applitools/eyes-storybook',
    reviewUrlPattern: /(https:\/\/\S*applitools\.com\/\S+)/,
  },
  CHROMATIC: {
    bin: 'chromatic',
    args: ({ snapshotDir }) => [
      '--storybook-build-dir',
      snapshotDir,
      // Differences are reported through our own status, not the exit code, so
      // a pending review does not read as a crashed CLI.
      '--exit-zero-on-changes',
    ],
    secretName: 'CHROMATIC_PROJECT_TOKEN',
    envVar: 'CHROMATIC_PROJECT_TOKEN',
    installHint: 'npm i -D chromatic',
    reviewUrlPattern: /(https:\/\/www\.chromatic\.com\/\S+)/,
  },
};

/**
 * Where the CLI would be if it were installed.
 *
 * Walks up from the run's working directory, because a monorepo hoists dev
 * dependencies to the root `node_modules/.bin` and the tests being run live
 * several directories below it.
 */
function resolveBin(cwd: string, bin: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A vendor run should not outlive the run that spawned it. */
const TIMEOUT_MS = 10 * 60_000;

export async function runVisualService(
  kind: VisualIntegrationKind,
  options: {
    snapshotDir: string;
    buildName: string;
    secrets: Readonly<Record<string, string>>;
    cwd: string;
  },
): Promise<VisualServiceResult> {
  const vendor = VENDORS[kind];
  const token = options.secrets[vendor.secretName];

  if (!token) {
    return {
      status: 'SKIPPED',
      message: `${kind} is enabled but ${vendor.secretName} is not set on this environment. Add it as a secret.`,
      reviewUrl: null,
    };
  }

  /*
   * A CLI that is not installed is a configuration gap, not a visual
   * regression. Checked before spawning rather than inferred from an exit code:
   * running it through a launcher makes "not installed" and "found differences"
   * both exit 1, and reporting the first as the second blames the application
   * for a missing dev dependency.
   */
  const binPath = resolveBin(options.cwd, vendor.bin);
  if (!binPath) {
    return {
      status: 'SKIPPED',
      message: `The ${kind} CLI (\`${vendor.bin}\`) is not installed. Add it with \`${vendor.installHint}\`.`,
      reviewUrl: null,
    };
  }

  const args = vendor.args({
    snapshotDir: options.snapshotDir,
    buildName: options.buildName,
  });

  return new Promise<VisualServiceResult>((resolve) => {
    /*
     * `shell: false` (the default here, stated for emphasis).
     *
     * The build name reaches this from a project name a user chose. Through a
     * shell, a project called `x; rm -rf ~` executes. Passing argv directly
     * means it can only ever be an argument.
     */
    const child = spawn(binPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        [vendor.envVar]: token,
        // Vendors colourise for a TTY; the escape codes wreck the URL match.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      shell: false,
    });

    let output = '';
    const collect = (chunk: Buffer) => {
      // Cap it: a chatty CLI should not be able to exhaust the worker's memory.
      if (output.length < 200_000) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT means the CLI is not installed — a configuration gap, not a
      // visual regression. Failing here would blame the application for a
      // missing dev dependency.
      resolve({
        status: 'SKIPPED',
        message:
          err.code === 'ENOENT'
            ? `The ${kind} CLI is not installed. Add it with \`${vendor.installHint}\`.`
            : `Could not run the ${kind} CLI: ${err.message}`,
        reviewUrl: null,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const reviewUrl = vendor.reviewUrlPattern.exec(output)?.[1] ?? null;

      if (signal === 'SIGKILL') {
        resolve({
          status: 'FAILED',
          message: `${kind} did not finish within ${TIMEOUT_MS / 60_000} minutes.`,
          reviewUrl,
        });
        return;
      }

      if (code === 0) {
        resolve({
          status: 'PASSED',
          message: reviewUrl
            ? `${kind} accepted the snapshots.`
            : `${kind} accepted the snapshots (no review URL in its output).`,
          reviewUrl,
        });
        return;
      }

      /*
       * A non-zero exit from these tools means "there are differences to look
       * at", which is a real finding but not necessarily a defect — a diff
       * pending human approval is the normal state of a visual workflow. It is
       * reported as a failure so the run does not go green on an unreviewed
       * change, and the message points at the review rather than at a stack
       * trace, because the next step is a person looking at two images.
       */
      const tail = output.trim().split('\n').slice(-4).join('\n').slice(0, 400);
      resolve({
        status: 'FAILED',
        message: reviewUrl
          ? `${kind} found visual differences awaiting review: ${reviewUrl}`
          : `${kind} exited ${code}.\n${tail}`,
        reviewUrl,
      });
    });
  });
}
