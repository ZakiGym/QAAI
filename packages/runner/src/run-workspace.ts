/**
 * The two things a plugin must learn from its run context that `RunContext`
 * does not yet carry: WHERE the test executes, and WHOSE session it executes
 * under.
 *
 * ── The defect this file exists to prevent ──────────────────────────────────
 *
 * INTEGRATION, UNIT_GEN and MUTATION all shell out to a command the customer
 * named, and every one of them resolved its working directory from
 * `process.cwd()`. On the cloud worker that is QAAI'S OWN CHECKOUT. So a spec
 * saying `npx vitest run` ran QAAI's test suite and filed the result as the
 * customer's; `mvn test` found no POM and filed "there is no POM in this
 * directory" as a verdict on their application; and a `cwd` of `../..` walked
 * out of the monorepo entirely. They ran something. It was not the customer's
 * code.
 *
 * The fix is a real workspace per run, materialised from the customer's
 * connected repository by the worker (see `apps/worker/src/repo-materialise.ts`,
 * which owns the fetch, the limits and the cleanup), and handed to the plugins
 * through the run context. This module is the CONTRACT for that handover plus
 * the one path guard every writer into the workspace must pass through.
 *
 * ── The second defect: one session for a whole suite ────────────────────────
 *
 * A run resolved ONE storage state — the first auth profile on the environment
 * — and applied it to every test. A plan item can name an `authProfileId`, so a
 * suite legitimately holds an admin test and a member test, and under one
 * session at most one of them was running as the role it claims. The identity
 * half of this file ({@link declaredAuthProfileId},
 * {@link suppliedAuthProfileId}) is how the harness compares the role a test
 * ASKED for against the one the run actually supplied, and refuses rather than
 * running a role test anonymously. It lives here rather than in `login.ts`
 * because the harness must make that comparison without importing a browser
 * driver to do it.
 *
 * ── The two channels, now plain fields ──────────────────────────────────────
 *
 * `RunContext.workspace` and `RunContext.authProfileId` live in
 * `packages/shared/src/types.ts` and are read here as ordinary fields. They
 * were casts for exactly as long as the types lived in this package, and a
 * context field that only exists at a cast is a field the next caller does not
 * know about: it cannot be discovered from the type, so the next plugin that
 * needs the workspace reaches for `process.cwd()` instead — which is precisely
 * the defect this file was written to close.
 *
 * The accessors stay, because the CHECK is the point: `runWorkspaceOf` returns
 * null rather than a path when there is no checkout, and the identity pair is
 * what lets the harness compare the role a test asked for against the one the
 * run supplied and refuse, instead of running anonymously and passing.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExecutableTest, RunContext } from '@qaai/shared';

/*
 * `RunWorkspace` now lives in packages/shared/src/types.ts, as a FIELD on
 * `RunContext` rather than a side channel reached through a cast. Re-exported
 * here so every existing `import { RunWorkspace } from '../run-workspace.js'`
 * keeps working and there is still one name for it.
 */
export type { RunWorkspace } from '@qaai/shared';
import type { RunWorkspace } from '@qaai/shared';


/** The workspace for this run, or null when none was materialised. */
export function runWorkspaceOf(ctx: RunContext): RunWorkspace | null {
  return ctx.workspace ?? null;
}

/**
 * Bind a materialised workspace to a run context.
 *
 * Returns the same object (contexts are built per test by the worker and passed
 * straight to a plugin), so a caller can write
 * `attachRunWorkspace(ctx, workspace)` as a statement and keep its own typing.
 */
export function attachRunWorkspace<T extends RunContext>(
  ctx: T,
  workspace: RunWorkspace | null,
): T {
  (ctx as T & { workspace?: RunWorkspace | null }).workspace = workspace;
  return ctx;
}

/**
 * Resolve a repo-relative path inside the workspace, or null if it escapes.
 *
 * `test.filePath` is MODEL-AUTHORED — the Generator produced it — and it ends
 * up as a real path that the worker, not the tenant, writes with. A `filePath`
 * of `../../../../etc/cron.d/qaai` or `/root/.ssh/authorized_keys` is a write
 * as the worker process anywhere on its disk, and the worker holds
 * VAULT_MASTER_KEY. So every write into a workspace goes through here, and a
 * refusal is a refusal: there is no "clean it up and carry on" branch, because
 * silently rewriting a traversal attempt into something safe hides the fact
 * that the path was wrong.
 *
 * Returns null rather than throwing: every caller in this package owes the user
 * a typed outcome naming the offending path, and an exception would be caught
 * two layers up and reported as a bare failure.
 */
export function resolveInsideWorkspace(root: string, relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null;

  // Windows separators and drive letters: `C:\x` is absolute on Windows and a
  // plain relative name on POSIX, so it is refused on both rather than
  // resolving to something different per host.
  const unified = relPath.replace(/\\/g, '/');
  if (isAbsolute(relPath) || isAbsolute(unified) || /^[a-zA-Z]:/.test(unified)) return null;
  if (unified.split('/').includes('..')) return null;

  const base = resolve(root);
  const full = resolve(base, unified);

  // Belt and braces: even with the `..` check above, a symlinked root or a
  // future normalisation quirk must not get past this.
  if (full === base) return null;
  const rel = relative(base, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!full.startsWith(base + sep)) return null;

  return full;
}

// ─── Which identity a test runs as ───────────────────────────────────────────

/**
 * The role this test asked to run as, or null for the run's default.
 *
 * Treats an empty string as "unset": a nullable text column that reached here
 * as `''` means nobody chose a profile, and resolving `''` as a profile id
 * would look up nothing and then fall back to anonymous, which is the failure
 * mode this whole change exists to remove.
 */
export function declaredAuthProfileId(test: ExecutableTest): string | null {
  const value = test.authProfileId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * "This test is meaningless signed out."
 *
 * The INTENT, where `authProfileId` is the binding — they are separate columns
 * precisely because deleting a profile nulls the binding (`onDelete: SetNull`)
 * and must not be allowed to erase the fact that a role was asked for. A test
 * left with the intent and no binding is a BROKEN BINDING, and the one thing it
 * must never do is run anonymously and pass.
 */
export function authProfileRequired(test: ExecutableTest): boolean {
  return test.authProfileRequired === true;
}

/** The profile whose session `ctx.storageState` actually holds, if any. */
export function suppliedAuthProfileId(ctx: RunContext): string | null {
  const value = ctx.authProfileId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Record which profile's session the worker put in this context.
 *
 * Always called alongside setting `storageState`, and null means "the run's
 * default, or nothing". The pair is what makes the harness's refusal possible:
 * a context carrying a session it cannot attribute is indistinguishable from
 * one carrying the wrong session.
 */
export function attachAuthProfile<T extends RunContext>(ctx: T, profileId: string | null): T {
  (ctx as T & { authProfileId?: string | null }).authProfileId = profileId;
  return ctx;
}
