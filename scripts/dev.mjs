#!/usr/bin/env node
/**
 * `npm run dev` — the whole stack, one command.
 *
 * package.json has pointed at this file since the beginning and the file did
 * not exist, so the documented way to start QAAI failed with MODULE_NOT_FOUND
 * and everyone ran four terminals instead.
 *
 * Four processes, one prefixed stream, one Ctrl-C. The prefix matters more than
 * it sounds: with four servers interleaving on one terminal, an unlabelled
 * stack trace tells you something broke but not what, and the first thing you
 * do is start them separately again to find out.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Ordered deliberately. The API is first because the worker and the web app
 * both talk to it, and its env parsing fails loudly at boot — if VAULT_MASTER_KEY
 * is missing you want that error at the top of the log, not buried under
 * Next.js's startup banner.
 */
const SERVICES = [
  { name: 'api', workspace: '@qaai/api', colour: '\x1b[36m', port: 4000 },
  { name: 'worker', workspace: '@qaai/worker', colour: '\x1b[35m', port: null },
  { name: 'demo', workspace: '@qaai/demo', colour: '\x1b[33m', port: 5050 },
  { name: 'web', workspace: '@qaai/web', colour: '\x1b[32m', port: 3000 },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const width = Math.max(...SERVICES.map((s) => s.name.length));

/** Set once we are intentionally tearing down, so exits stop looking like crashes. */
let shuttingDown = false;
const children = [];

function log(service, line) {
  process.stdout.write(`${service.colour}${service.name.padEnd(width)}${RESET} ${DIM}│${RESET} ${line}\n`);
}

for (const service of SERVICES) {
  const child = spawn('npm', ['run', 'dev', '-w', service.workspace], {
    // Piped rather than inherited: inheriting gives four unlabelled streams
    // racing for the same terminal, which is the problem this script exists to
    // solve. shell:false — nothing here is user input, but there is no reason
    // to hand argv to a shell.
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  children.push(child);

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      // Blank lines are most of a dev server's output and add nothing once
      // every line is prefixed anyway.
      if (line.trim()) log(service, line);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(service, `${service.colour}exited${RESET} with ${signal ?? `code ${code}`}`);
    /*
     * One service dying takes the rest down.
     *
     * A half-running stack is worse than a stopped one: the web app still
     * serves, so it looks fine, and every request fails against an API that is
     * not there. Better to stop loudly and let the reason stay on screen.
     */
    shutdown(code ?? 1);
  });

  child.on('error', (err) => {
    log(service, `could not start: ${err.message}`);
    shutdown(1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    // SIGTERM so each server runs its own cleanup; anything still alive after
    // the grace period is not going to exit on its own.
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write('\n');
    shutdown(0);
  });
}

const ports = SERVICES.filter((s) => s.port).map((s) => `${s.name} :${s.port}`);
process.stdout.write(`${DIM}starting ${SERVICES.length} services — ${ports.join(', ')}${RESET}\n`);
