-- SSO (§1) — SAML 2.0 and OIDC connections, DNS-verified email domains, and the
-- two anti-replay tables the login path needs.
--
-- Additive by construction: four new tables and one new enum, no column added
-- to and no constraint changed on anything that already exists. Every code path
-- that never touches SSO behaves exactly as it did before this migration.
--
-- The one constraint here that is a security control rather than hygiene is
-- `SsoDomain_domain_key`. `User` is a global table and a session can switch
-- between every org its user belongs to, so an org able to claim a domain it
-- does not own could have its IdP assert any address in that domain and be
-- handed a session for that person — and then switch into their other orgs.
-- The domain is therefore unique across the WHOLE table, not per org, and
-- `verifiedAt` (set only after a DNS TXT proof) is what the login path filters
-- on. Do not relax this index to a composite with orgId.

-- CreateEnum
CREATE TYPE "SsoProtocol" AS ENUM ('SAML', 'OIDC');

-- CreateTable
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "protocol" "SsoProtocol" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecretEnc" TEXT,
    "oidcKeyVersion" INTEGER,
    "oidcScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "samlIdpEntityId" TEXT,
    "samlSsoUrl" TEXT,
    "samlIdpCertsPem" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoDomain" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoLoginRequest" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonceHash" TEXT,
    "pkceVerifierEnc" TEXT,
    "keyVersion" INTEGER,
    "samlRequestId" TEXT,
    "redirectTo" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoLoginRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoAssertionSeen" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "assertionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoAssertionSeen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SsoConnection_orgId_idx" ON "SsoConnection"("orgId");

-- CreateIndex
-- Security control, not a convenience. See the header.
CREATE UNIQUE INDEX "SsoDomain_domain_key" ON "SsoDomain"("domain");

-- CreateIndex
CREATE INDEX "SsoDomain_orgId_idx" ON "SsoDomain"("orgId");

-- CreateIndex
CREATE INDEX "SsoDomain_connectionId_idx" ON "SsoDomain"("connectionId");

-- CreateIndex
-- The state row is claimed by a conditional UPDATE keyed on this hash, so the
-- uniqueness is what makes "consume exactly once" hold under concurrency.
CREATE UNIQUE INDEX "SsoLoginRequest_stateHash_key" ON "SsoLoginRequest"("stateHash");

-- CreateIndex
CREATE INDEX "SsoLoginRequest_orgId_idx" ON "SsoLoginRequest"("orgId");

-- CreateIndex
CREATE INDEX "SsoLoginRequest_expiresAt_idx" ON "SsoLoginRequest"("expiresAt");

-- CreateIndex
-- The SAML replay guard. Enforcement is this index rejecting the SECOND insert,
-- not the first one succeeding — a read-then-write would let two copies of one
-- assertion race each other through.
CREATE UNIQUE INDEX "SsoAssertionSeen_connectionId_assertionId_key" ON "SsoAssertionSeen"("connectionId", "assertionId");

-- CreateIndex
CREATE INDEX "SsoAssertionSeen_expiresAt_idx" ON "SsoAssertionSeen"("expiresAt");

-- AddForeignKey
ALTER TABLE "SsoConnection" ADD CONSTRAINT "SsoConnection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoDomain" ADD CONSTRAINT "SsoDomain_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SsoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoLoginRequest" ADD CONSTRAINT "SsoLoginRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SsoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoAssertionSeen" ADD CONSTRAINT "SsoAssertionSeen_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SsoConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
