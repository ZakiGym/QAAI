/**
 * Record mode — click through your app, get a Playwright test.
 *
 * This wraps Playwright's own `codegen` rather than reinventing DOM-event
 * capture. That is a deliberate build-vs-buy call: codegen is battle-tested,
 * it handles cross-origin pages and shadow DOM that an injected snippet cannot,
 * and it already emits resilient role/label/text locators — exactly the kind
 * QAAI's Generator is told to prefer. Reimplementing all of that worse would be
 * the wrong use of effort.
 *
 * What QAAI adds on top is the part codegen does not do: naming the test and
 * making its URLs relative to the environment's base URL, so the recording is a
 * portable spec the customer owns rather than a script pinned to one host.
 *
 * It runs wherever a human can see a browser window — the desktop app or local
 * dev. A headless server has no display for the codegen window to open on, so
 * this is not a queue job; the API that owns a screen spawns it directly.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playwrightCliPath } from './playwright-harness.js';

/** A recording browser left open forever should not leak a process indefinitely. */
const MAX_RECORD_MS = 20 * 60_000;

export interface RecordingSession {
  /** Resolves with the generated spec source once the browser window is closed. */
  done: Promise<string>;
  /** Closes the codegen browser and rejects `done`. */
  cancel: () => void;
}

/**
 * Opens a codegen browser at `url` and resolves when the user closes it.
 *
 * The url is trusted to be a validated http(s) URL — callers pass an
 * environment's base URL, which is checked at creation — and it is handed to
 * `spawn` as an argv element, never through a shell, so there is no injection
 * surface even if that assumption were ever wrong.
 */
export function startRecording(url: string): RecordingSession {
  let child: ReturnType<typeof spawn> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const done = new Promise<string>((resolve, reject) => {
    void mkdtemp(join(tmpdir(), 'qaai-record-'))
      .then((dir) => {
        const outputPath = join(dir, 'recorded.spec.ts');

        child = spawn(
          playwrightCliPath,
          ['codegen', '--target', 'playwright-test', '--output', outputPath, url],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );

        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        timeout = setTimeout(() => child?.kill('SIGTERM'), MAX_RECORD_MS);

        child.on('error', (err) => {
          if (timeout) clearTimeout(timeout);
          void rm(dir, { recursive: true, force: true });
          reject(new Error(`Could not launch the recorder: ${err.message}`));
        });

        child.on('exit', async (code, signal) => {
          if (timeout) clearTimeout(timeout);
          try {
            // A cancelled recording (SIGTERM) has no spec to read; that is the
            // user backing out, not a failure to report as one.
            if (signal === 'SIGTERM') {
              reject(new Error('Recording cancelled'));
              return;
            }
            const raw = await readFile(outputPath, 'utf8').catch(() => '');
            if (!raw.trim()) {
              // Closing the window without recording an action leaves an empty
              // or missing file. A likely cause on a server is no display.
              reject(
                new Error(
                  code === 0
                    ? 'No actions were recorded'
                    : `The recorder exited unexpectedly.${
                        /display|DISPLAY|headless/i.test(stderr)
                          ? ' No display is available — record mode needs a screen (run it from the desktop app or local dev).'
                          : ''
                      }`,
                ),
              );
              return;
            }
            resolve(raw);
          } finally {
            void rm(dir, { recursive: true, force: true });
          }
        });
      })
      .catch(reject);
  });

  return {
    done,
    cancel: () => {
      if (timeout) clearTimeout(timeout);
      child?.kill('SIGTERM');
    },
  };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns raw codegen output into a spec QAAI can store and run anywhere.
 *
 * Two changes, both about portability:
 *  - Rename `test('test', …)` to the name the user gave the recording.
 *  - Rewrite absolute URLs that point at the environment's base URL into
 *    relative paths, so the test runs against staging, preview, or prod
 *    depending on which environment triggers it — not only the host it was
 *    recorded against. This mirrors how the Generator writes `page.goto('/…')`.
 *
 * Everything else codegen produced — the locators, the assertions — is already
 * what a good hand-written test looks like, and is left untouched.
 */
export function cleanupRecordedSpec(
  rawCode: string,
  opts: { name: string; baseUrl: string },
): string {
  let code = rawCode;

  const safeName = opts.name.replace(/['"`\\]/g, '').trim() || 'Recorded test';
  code = code.replace(/test\(\s*(['"`])test\1/, `test('${safeName}'`);

  const base = opts.baseUrl.replace(/\/+$/, '');
  if (base) {
    // `https://host/products` → `/products`
    code = code.replace(new RegExp(`(['"\`])${escapeRegExp(base)}/`, 'g'), '$1/');
    // bare `https://host` or `https://host/` → `/`
    code = code.replace(new RegExp(`(['"\`])${escapeRegExp(base)}/?\\1`, 'g'), '$1/$1');
  }

  return code;
}
