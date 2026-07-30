-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationKind" ADD VALUE 'BROWSERSTACK';
ALTER TYPE "IntegrationKind" ADD VALUE 'SAUCE_LABS';
ALTER TYPE "IntegrationKind" ADD VALUE 'LAMBDATEST';
ALTER TYPE "IntegrationKind" ADD VALUE 'PERFECTO';
ALTER TYPE "IntegrationKind" ADD VALUE 'APPLITOOLS';
ALTER TYPE "IntegrationKind" ADD VALUE 'PERCY';
ALTER TYPE "IntegrationKind" ADD VALUE 'CHROMATIC';
