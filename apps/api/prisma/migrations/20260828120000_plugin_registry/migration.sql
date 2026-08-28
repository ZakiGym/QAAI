-- The plugin registry: trusted publishers, installed plugins, per-project
-- enablement.
--
-- Purely additive. Three new tables, no column added to and no constraint
-- changed on any existing one — the only touch outside the new relations is
-- Project gaining a child, which is a foreign key declared on the CHILD and
-- takes no lock on Project's rows. On a live database this is three CREATE
-- TABLEs plus index builds on empty relations, so it is safe to apply while the
-- API is serving.
--
-- Nothing back-fills. An org with no PluginPublisher row trusts nobody and can
-- install nothing, which is the correct state for every existing install: the
-- feature arrives switched off rather than arriving with a default trust
-- anchor somebody has to remember to remove.
--
-- NOT RUN by this change. `prisma migrate deploy` applies it.

-- CreateTable
CREATE TABLE "PluginPublisher" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginPublisher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "publisherRowId" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "homepage" TEXT,
    "protocol" INTEGER NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "governedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codeSha256" TEXT NOT NULL,
    "codeBytes" INTEGER NOT NULL,
    "codeEntry" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "installedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginEnablement" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginEnablement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PluginPublisher_orgId_idx" ON "PluginPublisher"("orgId");

-- CreateIndex
-- One key per publisher name per org, enforced by the database rather than by
-- the handler. Two rows for "acme" would turn "is this signature from acme"
-- into a loop over candidate keys, and a loop that accepts if ANY key matches
-- is a loop in which revoking one key changes nothing.
CREATE UNIQUE INDEX "PluginPublisher_orgId_publisherId_key" ON "PluginPublisher"("orgId", "publisherId");

-- CreateIndex
CREATE INDEX "Plugin_orgId_idx" ON "Plugin"("orgId");

-- CreateIndex
CREATE INDEX "Plugin_publisherRowId_idx" ON "Plugin"("publisherRowId");

-- CreateIndex
-- The install path's collision check, and the reason a race between two
-- simultaneous installs of the same name ends as a 409 rather than as two rows.
CREATE UNIQUE INDEX "Plugin_orgId_name_key" ON "Plugin"("orgId", "name");

-- CreateIndex
CREATE INDEX "PluginEnablement_orgId_idx" ON "PluginEnablement"("orgId");

-- CreateIndex
-- "Which plugins may run against this project?" — the read the runner makes at
-- the start of every run, so it must be an index probe and not a scan of every
-- enablement the org has ever recorded.
CREATE INDEX "PluginEnablement_projectId_enabled_idx" ON "PluginEnablement"("projectId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PluginEnablement_pluginId_projectId_key" ON "PluginEnablement"("pluginId", "projectId");

-- AddForeignKey
-- RESTRICT, deliberately, and the only RESTRICT in this migration: deleting a
-- publisher row while plugins are installed under it would leave code running
-- whose provenance can no longer be established. Revocation is a timestamp on
-- the row (see PluginPublisher.revokedAt) precisely so that "we no longer trust
-- them" never has to be expressed as a delete.
ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_publisherRowId_fkey" FOREIGN KEY ("publisherRowId") REFERENCES "PluginPublisher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE: uninstalling must stop the plugin everywhere in the same statement.
-- An enablement row outliving its plugin is a project still marked as running
-- something that no longer exists.
ALTER TABLE "PluginEnablement" ADD CONSTRAINT "PluginEnablement_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginEnablement" ADD CONSTRAINT "PluginEnablement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
