-- The browser capability nothing collected, and the row that makes
-- `resolveMatrixCell` able to give an answer other than NOT_CHECKED.
--
-- WHY THIS EXISTS
--
-- `DeploymentBrowsers` (packages/shared/src/browser-matrix.ts) is the fact every
-- browser/device cell is resolved against, and its own header named the
-- collector: "the one thin adapter that actually stats a browser install lives
-- in packages/runner/src/preflight.ts". The adapter did not exist. So every
-- `resolveMatrixCell` call in the product was made against an empty capability,
-- and NOT_CHECKED was not merely the usual answer -- it was the ONLY answer six
-- statuses could ever produce, for every cell, on every deployment, for ever.
-- The preceding migration (20261027090000_browser_matrix_cells_and_unasserted_
-- honesty) added the cells, the `MatrixCellStatus` enum and the per-cell
-- evidence columns; this one adds the half that lets a cell be refused for a
-- reason, with a remedy somebody can act on.
--
-- ONE TABLE, WITH BOTH PATHS IN THE SAME CHANGE
--
-- `apps/worker/src/processors/preflight.ts` writes these rows inside the
-- capability preflight job (`probeDeploymentBrowserCapability`) and reads them
-- back in the same pass (`deploymentBrowserCapabilities`), where they are turned
-- into a `DeploymentBrowsers` and handed to `resolveMatrixCell`. A correct
-- Prisma model connected to nothing is this codebase's signature defect and
-- three keystones in a row shipped one, so `check:wiring` must report 0
-- disconnected after this migration exactly as it did before it.
--
-- WHY A ROW ONLY EXISTS WHEN THE PROBE ANSWERED
--
-- `installed` and `checkedAt` are both NOT NULL, which is deliberately different
-- from `DeploymentCapability` -- there, a NOT_CHECKED row is written for all
-- nineteen types so the denominator is always complete. Here the vocabulary is
-- 27 axis members and most of them are UNANSWERABLE on a given host: Playwright
-- resolves a browser channel by absolute per-platform paths, not through PATH,
-- so a PATH miss is not evidence of absence. `installed = false` for those would
-- REFUSE a cell on a machine that has the browser installed, and a NOT_CHECKED
-- row for each would be 27 rows of nothing per deployment. So THE MISSING ROW IS
-- THE NOT_CHECKED, which is the contract `DeploymentBrowsers` already documents:
-- every field optional, absent means not probed.
--
-- The writer deletes a member's row when the probe stops being able to answer
-- for it, because a retained `installed = true` for a browser that has since
-- been removed from the image is precisely the stale AVAILABLE that
-- `DeploymentCapability.checkedAt` exists to kill.
--
-- NO NEW ENUM, ON PURPOSE
--
-- `axis` is TEXT holding 'ENGINE', 'CHANNEL' or 'DEVICE_PRESET'. A Prisma enum
-- needs its TypeScript twin in packages/shared/src/constants.ts and its pair in
-- apps/api/scripts/check-enums.ts, and `check:enums` fails a value with no twin
-- in either direction; neither file belongs to the slice that added this table,
-- and a half-made pair is exactly the state those guards exist to refuse. The
-- union is compiler-enforced in packages/runner/src/preflight.ts
-- (`BROWSER_CAPABILITY_AXIS_PRESENT`) and validated on both sides of the column,
-- so `check:enums` still reports the same 46 pairs it did before this migration.
--
-- WRITTEN BY HAND. `prisma migrate dev` was not run -- no database is reachable
-- here and the round's rules forbid it -- so this file is hand-authored against a
-- `prisma validate`-clean schema and a regenerated client. It has NOT been
-- applied.

CREATE TABLE "DeploymentBrowserCapability" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "deploymentKey" TEXT NOT NULL DEFAULT '<self>',
    "axis" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentBrowserCapability_pkey" PRIMARY KEY ("id")
);

-- One reading per (deployment, axis, member). The upsert is keyed on it, so a
-- second probe of the same deployment updates the reading instead of appending a
-- second opinion about the same browser.
CREATE UNIQUE INDEX "DeploymentBrowserCapability_deploymentKey_axis_name_key" ON "DeploymentBrowserCapability"("deploymentKey", "axis", "name");

CREATE INDEX "DeploymentBrowserCapability_orgId_idx" ON "DeploymentBrowserCapability"("orgId");

-- "what can this deployment's browser matrix serve" -- the read that becomes a
-- `DeploymentBrowsers` and is handed to `resolveMatrixCell`.
CREATE INDEX "DeploymentBrowserCapability_deploymentKey_installed_idx" ON "DeploymentBrowserCapability"("deploymentKey", "installed");
