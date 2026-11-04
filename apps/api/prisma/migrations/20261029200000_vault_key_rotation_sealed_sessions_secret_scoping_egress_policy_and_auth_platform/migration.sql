-- The security controls the hosted product cannot be sold without, and must not
-- be run without. Six types, eight tables and twenty-four columns.
--
-- WHY THIS EXISTS. Each item below is a reproduced defect, not a hardening idea.
--
--   1. A COMPROMISE CANNOT BE REMEDIATED. apps/api/src/lib/vault.ts supports
--      exactly ONE key version -- `keyForVersion` reads `if (version === 1)`
--      and throws for everything else -- `needsRotation` has NO CALLER in the
--      repo, and the file's header describes a lazy re-encrypt that does not
--      exist. So rotating the master key makes every sealed secret in the
--      install permanently unreadable, and the only available response to a
--      leaked key is to keep using it. "VaultKey" and "KeyRotationSweep" are
--      what make rotation a thing that can be done, resumed and audited.
--   2. LIVE CUSTOMER SESSION COOKIES SAT IN A PLAIN JSON COLUMN.
--      "AuthProfile"."storageState" is a cached Playwright session for the
--      customer's own application -- possession of it IS possession of their
--      session -- and it was unencrypted, with no key version, no refresh and
--      an 8-hour TTL that nothing ever renewed. An expired session silently
--      degraded every nightly run to anonymous, which also made every
--      auth-gated route look covered by an anonymous test.
--   3. EVERY DECRYPTED SECRET WENT TO EVERY TEST. There is no per-test scoping,
--      so a test that needs a payment provider's test key also receives the
--      production database password. "SecretScope" is the scoping, and the
--      ABSENCE of a row is the denial.
--   4. THE CRAWLER NEVER CLASSIFIED THE HOST. "Environment"."baseUrl" was
--      validated by `z.string().url()` plus an http/https check and nothing
--      else, so loopback, RFC1918, link-local and 169.254.169.254 were all
--      accepted at the door -- and a MEMBER's FORM_LOGIN profile then drives a
--      browser at that URL and TYPES VAULT PLAINTEXT into whatever answers.
--      "Environment"."egressPolicy", "EgressAllowlistEntry" and
--      "EgressDecisionTally" are the policy, the owned escape, and the count
--      that lets it be switched on.
--   5. LOGIN ACCEPTED ANY SUPPLIED TOTP CODE. apps/api/src/routes/auth.ts reads
--      `if (user.totpEnabledAt && !input.totpCode) throw` and never looks at
--      the code again: presence is checked, the value is not.
--      "User"."totpConfirmedAt", "TotpRecoveryCode", "LoginThrottle" and
--      "LoginAttempt" are what a verified second factor needs.
--   6. THERE WAS NO WAY TO SIGN OUT A LOST LAPTOP, no enforce-SSO and no
--      per-identifier throttle. "Session"."deviceLabel"/"lastSeenAt"/
--      "revokedReason"/"revokedBy" and "Organization"."enforceSso" are those.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES TO THE PLAINTEXT SESSIONS ALREADY IN THE DATABASE.
-- Stated at the top because it is the only destructive thing here.
--
-- IT DELETES THEM. Step 9 sets "storageState" and "storageStateExpiresAt" to
-- NULL for every row that had one, and sets "storageStateNeedsReseal" TRUE on
-- exactly those rows.
--
-- SQL CANNOT ENCRYPT. The vault key is not in the database and must never be,
-- so sealing the existing values in the migration is not available. That left
-- two options, and only one of them is defensible:
--
--   * leave the plaintext in place while the schema and every doc comment claim
--     the column is sealed -- which is the worst possible outcome, because the
--     next reviewer trusts the comment instead of reading the rows; or
--   * drop the cache.
--
-- The cache is REGENERABLE. A profile with no session signs in again on its
-- next run, through `signInWithProfile`, which already exists and already
-- works; the cost is one extra login per profile per environment, once. Leaked
-- session cookies are not regenerable. So the cache goes.
--
-- BOTH COLUMNS ARE NULLED TOGETHER, and that is not tidiness. Nulling the state
-- and leaving the expiry would make the check in apps/api/src/routes/projects.ts
-- (`storageStateExpiresAt !== null && > now`) report a VALID SESSION for a
-- profile that has none -- two facts in one field, which is a defect even when
-- both values are individually defensible.
--
-- "storageState" IS NOT DROPPED HERE. apps/worker/src/processors/explore.ts and
-- apps/api/src/routes/projects.ts still name it, so dropping it in the same
-- migration would be a deploy that fails on the old image. It is dropped in a
-- later migration once no code reads it, which is a separate decision with its
-- own evidence.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NO NEW ENVIRONMENT VARIABLE. "VaultKey"."providerRef" holds a KMS key
-- reference ON THE ROW, because a customer's key identifier belongs on a model
-- row they own and not in process.env -- and the product works with no KMS
-- configured, which is the condition that choice is held to. VAULT_MASTER_KEY
-- stays exactly as it is and keeps opening everything it opened before: it is
-- registered as version 1 by the first "VaultKey" row an operator writes, and
-- nothing in this migration changes how a version-1 value is read.
--
-- NO ROW IS SEEDED. Not even a version-1 "VaultKey". A seeded row would be this
-- migration asserting, about a database it cannot read, that the deployment's
-- master key is the one that sealed its existing secrets -- and for a
-- deployment that has already rotated by hand (there is no supported way, but
-- there is an unsupported one) that assertion would be false and would retire
-- the only key that works. Registration is an explicit operator action through
-- `registerVaultKeySchema`.

-- ─── 1. The types ───────────────────────────────────────────────────────────
-- Order within each type is the Postgres sort order, which is the order a
-- cockpit list comes back in, so it matches the TypeScript array member for
-- member and position for position.

CREATE TYPE "VaultKeyState" AS ENUM ('ACTIVE', 'READABLE', 'RETIRED', 'COMPROMISED');
CREATE TYPE "VaultKeyProvider" AS ENUM ('LOCAL', 'KMS');
CREATE TYPE "KeyRotationState" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED');
CREATE TYPE "SecretScopeKind" AS ENUM ('TEST', 'SUITE', 'TEST_TYPE', 'AUTH_PROFILE', 'ENVIRONMENT_WIDE');
CREATE TYPE "EgressOutcome" AS ENUM ('ALLOWED', 'REFUSED', 'WOULD_REFUSE');
CREATE TYPE "LoginAttemptOutcome" AS ENUM ('SUCCESS', 'BAD_PASSWORD', 'BAD_TOTP', 'UNKNOWN_IDENTIFIER', 'LOCKED_OUT', 'SSO_REQUIRED', 'EMAIL_UNVERIFIED');

-- ─── 2. The keys, and the sweep that makes rotation resumable ───────────────

CREATE TABLE "VaultKey" (
  "id"            TEXT NOT NULL,
  "keyId"         TEXT NOT NULL,
  "version"       INTEGER NOT NULL,
  "state"         "VaultKeyState" NOT NULL,
  "provider"      "VaultKeyProvider" NOT NULL DEFAULT 'LOCAL',
  "providerRef"   TEXT,
  "note"          TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt"   TIMESTAMP(3),
  "rotatedOutAt"  TIMESTAMP(3),
  "retiredAt"     TIMESTAMP(3),
  "compromisedAt" TIMESTAMP(3),
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VaultKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VaultKey_keyId_key" ON "VaultKey"("keyId");
-- A version carried in an envelope MUST NEVER be reused: two keys sharing one
-- is two ciphertexts that both claim to be openable by one key, and no reader
-- can tell which is which. The unique index is what makes that impossible
-- rather than discouraged.
CREATE UNIQUE INDEX "VaultKey_version_key" ON "VaultKey"("version");
CREATE INDEX "VaultKey_state_idx" ON "VaultKey"("state");

CREATE TABLE "KeyRotationSweep" (
  "id"             TEXT NOT NULL,
  "fieldKey"       TEXT NOT NULL,
  "fromKeyVersion" INTEGER NOT NULL,
  "toKeyVersion"   INTEGER NOT NULL,
  "state"          "KeyRotationState" NOT NULL DEFAULT 'PENDING',
  "visited"        INTEGER NOT NULL DEFAULT 0,
  "resealed"       INTEGER NOT NULL DEFAULT 0,
  "unopenable"     INTEGER NOT NULL DEFAULT 0,
  "skipped"        INTEGER NOT NULL DEFAULT 0,
  "cursor"         TEXT,
  "error"          TEXT,
  "startedAt"      TIMESTAMP(3),
  "finishedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KeyRotationSweep_pkey" PRIMARY KEY ("id")
);
-- ONE SWEEP PER (FIELD, FROM, TO). A second sweep over the same pair re-reads
-- every row and reports two different progress figures for one rotation, at
-- which point neither can be the evidence for retiring the old key.
CREATE UNIQUE INDEX "KeyRotationSweep_fieldKey_fromKeyVersion_toKeyVersion_key"
  ON "KeyRotationSweep"("fieldKey", "fromKeyVersion", "toKeyVersion");
CREATE INDEX "KeyRotationSweep_state_idx" ON "KeyRotationSweep"("state");
ALTER TABLE "KeyRotationSweep" ADD CONSTRAINT "KeyRotationSweep_fromKeyVersion_fkey"
  FOREIGN KEY ("fromKeyVersion") REFERENCES "VaultKey"("version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KeyRotationSweep" ADD CONSTRAINT "KeyRotationSweep_toKeyVersion_fkey"
  FOREIGN KEY ("toKeyVersion") REFERENCES "VaultKey"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. Per-test secret scoping. Absence of a row is the denial. ────────────

CREATE TABLE "SecretScope" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "secretId"  TEXT NOT NULL,
  "kind"      "SecretScopeKind" NOT NULL,
  "value"     TEXT,
  "reason"    TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecretScope_pkey" PRIMARY KEY ("id")
);
-- A duplicate is not a wider grant: it is two authors who each believed they
-- were the one who opened it, and the audit cannot then say who.
CREATE UNIQUE INDEX "SecretScope_secretId_kind_value_key" ON "SecretScope"("secretId", "kind", "value");
CREATE INDEX "SecretScope_orgId_idx" ON "SecretScope"("orgId");
CREATE INDEX "SecretScope_kind_value_idx" ON "SecretScope"("kind", "value");
ALTER TABLE "SecretScope" ADD CONSTRAINT "SecretScope_secretId_fkey"
  FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. Egress: the owned escape and the count ──────────────────────────────

CREATE TABLE "EgressAllowlistEntry" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "environmentId" TEXT,
  "host"          TEXT NOT NULL,
  "contexts"      TEXT[],
  -- NOT NULL, both of them, and that is the design. A consumer cannot forget a
  -- field it cannot construct the row without, which is the only form of this
  -- rule that has ever held: five suppression mechanisms each shipped with a
  -- nullable expiry and every one of them outlived its reason.
  "ownerEmail"    TEXT NOT NULL,
  "reason"        TEXT NOT NULL,
  "expiresAt"     TIMESTAMP(3),
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EgressAllowlistEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EgressAllowlistEntry_orgId_environmentId_host_key"
  ON "EgressAllowlistEntry"("orgId", "environmentId", "host");
CREATE INDEX "EgressAllowlistEntry_orgId_idx" ON "EgressAllowlistEntry"("orgId");
CREATE INDEX "EgressAllowlistEntry_environmentId_host_idx"
  ON "EgressAllowlistEntry"("environmentId", "host");
ALTER TABLE "EgressAllowlistEntry" ADD CONSTRAINT "EgressAllowlistEntry_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EgressAllowlistEntry" ADD CONSTRAINT "EgressAllowlistEntry_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EgressDecisionTally" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "environmentId" TEXT,
  "context"       TEXT NOT NULL,
  "outcome"       "EgressOutcome" NOT NULL,
  "addressClass"  TEXT,
  "refusal"       TEXT,
  "host"          TEXT NOT NULL,
  "bucketDate"    TIMESTAMP(3) NOT NULL,
  "count"         INTEGER NOT NULL DEFAULT 0,
  -- Non-zero means the tally is a FLOOR and the reader must say so. A cap that
  -- bit without being disclosed is the defect, not the cap.
  "hostsOmitted"  INTEGER NOT NULL DEFAULT 0,
  "firstAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EgressDecisionTally_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EgressDecisionTally_bucket_key" ON "EgressDecisionTally"(
  "orgId", "environmentId", "context", "outcome", "addressClass", "refusal", "host", "bucketDate"
);
CREATE INDEX "EgressDecisionTally_orgId_bucketDate_idx" ON "EgressDecisionTally"("orgId", "bucketDate");
CREATE INDEX "EgressDecisionTally_environmentId_outcome_idx"
  ON "EgressDecisionTally"("environmentId", "outcome");
ALTER TABLE "EgressDecisionTally" ADD CONSTRAINT "EgressDecisionTally_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EgressDecisionTally" ADD CONSTRAINT "EgressDecisionTally_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 5. A verified second factor, and a throttle ────────────────────────────

CREATE TABLE "TotpRecoveryCode" (
  "id"         TEXT NOT NULL,
  -- HASHED AND NOT SEALED. A sealed value can be opened, so a sealed recovery
  -- code is a credential this process can read, print and leak. A hash cannot
  -- be opened by anybody, including us, which is the right property for a value
  -- whose only use is to be compared.
  "userId"     TEXT NOT NULL,
  "codeHash"   TEXT NOT NULL,
  "usedAt"     TIMESTAMP(3),
  "usedFromIp" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TotpRecoveryCode_codeHash_key" ON "TotpRecoveryCode"("codeHash");
CREATE INDEX "TotpRecoveryCode_userId_usedAt_idx" ON "TotpRecoveryCode"("userId", "usedAt");
ALTER TABLE "TotpRecoveryCode" ADD CONSTRAINT "TotpRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LoginThrottle" (
  "id"             TEXT NOT NULL,
  -- A HASH, NOT ANONYMISATION. An email is recoverable from its hash by a
  -- dictionary in seconds. What the hash buys is that this table -- which gets
  -- a row for every identifier anybody TRIES, including ones with no account --
  -- cannot be read as an address list, while the operator's own join from a
  -- "User"."email" they already hold still works.
  "identifierHash" TEXT NOT NULL,
  "failures"       INTEGER NOT NULL DEFAULT 0,
  "windowStart"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil"    TIMESTAMP(3),
  "lockCount"      INTEGER NOT NULL DEFAULT 0,
  "lastFailureAt"  TIMESTAMP(3),
  "lastSuccessAt"  TIMESTAMP(3),
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoginThrottle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginThrottle_identifierHash_key" ON "LoginThrottle"("identifierHash");
CREATE INDEX "LoginThrottle_lockedUntil_idx" ON "LoginThrottle"("lockedUntil");

CREATE TABLE "LoginAttempt" (
  "id"             TEXT NOT NULL,
  "identifierHash" TEXT NOT NULL,
  "outcome"        "LoginAttemptOutcome" NOT NULL,
  "ip"             TEXT,
  "userAgent"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LoginAttempt_identifierHash_createdAt_idx" ON "LoginAttempt"("identifierHash", "createdAt");
CREATE INDEX "LoginAttempt_outcome_createdAt_idx" ON "LoginAttempt"("outcome", "createdAt");

-- ─── 6. Columns on existing tables ──────────────────────────────────────────
--
-- EVERY NULLABLE COLUMN HERE IS NULLABLE BECAUSE NULL MEANS "WE DO NOT KNOW",
-- WHICH IS NOT THE SAME FACT AS ANY DEFAULT.
--
--   "User"."totpConfirmedAt" is NOT back-filled from "totpEnabledAt". Doing so
--   would assert that a code verified for every user who ever opened the
--   enrolment screen, and the whole reason this column exists is that no code
--   was ever checked. The pair (totpEnabledAt SET, totpConfirmedAt NULL) means
--   NOT ENROLLED, which is the only reading that neither locks out a user whose
--   authenticator never saw the seed nor accepts an unverified second factor.
--
--   "Session"."lastSeenAt" is NOT back-filled from "createdAt". "Signed in
--   three weeks ago" and "last used three weeks ago" are the two facts a person
--   uses to decide which session to kill, and conflating them makes the screen
--   useless for its only purpose.
--
--   "Session"."revokedReason" stays NULL beside a non-null "revokedAt" for
--   every session revoked before this column existed. A reader renders that as
--   "revoked, reason not recorded" and must never pick a member to stand in.
--
-- THE THREE NOT NULL COLUMNS ALL CARRY A DEFAULT, which is what makes them safe
-- on a populated table, and each default is the state the existing rows are
-- genuinely in: no organisation is enforcing SSO today, no new profile needs a
-- re-seal, and no refresh has failed because no refresh has ever been attempted.

ALTER TABLE "User" ADD COLUMN "totpSecretKeyVersion" INTEGER;
ALTER TABLE "User" ADD COLUMN "totpConfirmedAt" TIMESTAMP(3);

ALTER TABLE "Organization" ADD COLUMN "enforceSso" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "securityControlModes" JSONB;
ALTER TABLE "Organization" ADD COLUMN "loginThrottlePolicy" JSONB;

ALTER TABLE "Session" ADD COLUMN "deviceLabel" TEXT;
ALTER TABLE "Session" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "Session" ADD COLUMN "revokedBy" TEXT;
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

ALTER TABLE "ApiKey" ADD COLUMN "rotatedAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN "replacesKeyId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "rotationGraceUntil" TIMESTAMP(3);

ALTER TABLE "Environment" ADD COLUMN "egressPolicy" JSONB;

ALTER TABLE "AuthProfile" ADD COLUMN "storageStateSealed" TEXT;
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateKeyVersion" INTEGER;
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateSealedAt" TIMESTAMP(3);
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateNeedsReseal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateRefreshedAt" TIMESTAMP(3);
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateRefreshAttemptedAt" TIMESTAMP(3);
ALTER TABLE "AuthProfile" ADD COLUMN "storageStateRefreshFailures" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "AuthProfile_storageStateKeyVersion_idx" ON "AuthProfile"("storageStateKeyVersion");
CREATE INDEX "AuthProfile_storageStateNeedsReseal_idx" ON "AuthProfile"("storageStateNeedsReseal");

-- ─── 7. API-key scopes: no back-fill, and the reason is the defect ──────────
--
-- "ApiKey"."scopes" is left EXACTLY AS IT IS, including every empty array.
--
-- apps/api/src/middleware/auth.ts reads
-- `scopes: key.scopes.length > 0 ? key.scopes : ['*']`, so an empty array is a
-- WILDCARD today. Back-filling those rows with the six real scopes would be
-- this migration silently deciding that every unrestricted key in every
-- customer's install should stay unrestricted -- a privilege decision made by a
-- DDL script, about keys nobody has looked at, with no audit entry.
--
-- The reading flips in CODE, under `SECURITY_CONTROL_BRAKES.API_KEY_SCOPE`,
-- whose OBSERVE mode counts the requests an empty-scope key authorises. That
-- count is how many keys this is, and it must be read before the meaning
-- changes. The data is not touched either way.

-- ─── 8. Nothing is seeded ──────────────────────────────────────────────────
--
-- No "VaultKey" row, not even version 1. A seeded row would be this migration
-- asserting, about a database it cannot read, that VAULT_MASTER_KEY is the key
-- that sealed the existing secrets. Registration is an explicit operator action
-- through `registerVaultKeySchema`, which is also where the `note` column gets
-- a human's sentence rather than "created by migration".

-- ─── 9. THE PLAINTEXT SESSIONS. Read the header before changing this. ───────
--
-- Two statements, in this order, and the order matters: mark first, then
-- destroy. If the second statement fails the row is marked for re-seal and
-- still has its plaintext, which is recoverable. If they were reversed and the
-- marking failed, the row would have no session and nothing saying so -- which
-- reads exactly like a profile nobody has ever signed in as, and would send the
-- next reader looking for a bug in the sign-in path.

UPDATE "AuthProfile"
   SET "storageStateNeedsReseal" = true
 WHERE "storageState" IS NOT NULL;

UPDATE "AuthProfile"
   SET "storageState" = NULL,
       "storageStateExpiresAt" = NULL
 WHERE "storageState" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVERT
--
--   UPDATE "AuthProfile" SET "storageStateNeedsReseal" = false;
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateRefreshFailures";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateRefreshAttemptedAt";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateRefreshedAt";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateNeedsReseal";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateSealedAt";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateKeyVersion";
--   ALTER TABLE "AuthProfile" DROP COLUMN "storageStateSealed";
--   ALTER TABLE "Environment" DROP COLUMN "egressPolicy";
--   ALTER TABLE "ApiKey" DROP COLUMN "rotationGraceUntil";
--   ALTER TABLE "ApiKey" DROP COLUMN "replacesKeyId";
--   ALTER TABLE "ApiKey" DROP COLUMN "rotatedAt";
--   DROP INDEX "Session_userId_revokedAt_idx";
--   ALTER TABLE "Session" DROP COLUMN "revokedBy";
--   ALTER TABLE "Session" DROP COLUMN "revokedReason";
--   ALTER TABLE "Session" DROP COLUMN "lastSeenAt";
--   ALTER TABLE "Session" DROP COLUMN "deviceLabel";
--   ALTER TABLE "Organization" DROP COLUMN "loginThrottlePolicy";
--   ALTER TABLE "Organization" DROP COLUMN "securityControlModes";
--   ALTER TABLE "Organization" DROP COLUMN "enforceSso";
--   ALTER TABLE "User" DROP COLUMN "totpConfirmedAt";
--   ALTER TABLE "User" DROP COLUMN "totpSecretKeyVersion";
--   DROP TABLE "LoginAttempt";
--   DROP TABLE "LoginThrottle";
--   DROP TABLE "TotpRecoveryCode";
--   DROP TABLE "EgressDecisionTally";
--   DROP TABLE "EgressAllowlistEntry";
--   DROP TABLE "SecretScope";
--   DROP TABLE "KeyRotationSweep";
--   DROP TABLE "VaultKey";
--   DROP TYPE "LoginAttemptOutcome";
--   DROP TYPE "EgressOutcome";
--   DROP TYPE "SecretScopeKind";
--   DROP TYPE "KeyRotationState";
--   DROP TYPE "VaultKeyProvider";
--   DROP TYPE "VaultKeyState";
--
-- WHAT A REVERT COSTS, stated rather than discovered.
--
-- THE DELETED SESSIONS DO NOT COME BACK. Step 9 is not reversible by SQL and no
-- amount of DDL will restore a plaintext cache this migration destroyed on
-- purpose. The cost is bounded -- each profile signs in again on its next run --
-- but it is a cost a revert pays a second time, because the profiles that have
-- since sealed a session lose that too when "storageStateSealed" is dropped.
--
-- Dropping "VaultKey" and "KeyRotationSweep" returns the install to the state
-- where a compromised master key cannot be rotated, which is the state this
-- migration exists to leave. If any value has already been sealed under a
-- version other than 1 at the point of the revert, THAT VALUE BECOMES
-- PERMANENTLY UNREADABLE -- `keyForVersion` in apps/api/src/lib/vault.ts throws
-- for every version but 1. So a revert must be preceded by a completed rotation
-- BACK to version 1, with a "KeyRotationSweep" whose "unopenable" is zero, and
-- the sweep table is the evidence for that -- which is itself a reason to drop
-- these two tables last and only after reading them.
--
-- Dropping "SecretScope" returns every secret to being injected into every
-- test. Dropping "EgressDecisionTally" loses the count that justified arming
-- the egress brake, so the brake would have to be re-observed from zero.
-- Dropping "User"."totpConfirmedAt" returns login to accepting any six digits
-- from any enrolled user, which is the single most serious item this migration
-- addresses; a revert of that column must be paired with disabling TOTP
-- enrolment outright rather than leaving an unverified factor in place.
-- ─────────────────────────────────────────────────────────────────────────────
