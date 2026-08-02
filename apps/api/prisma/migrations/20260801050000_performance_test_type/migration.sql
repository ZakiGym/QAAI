-- One new TestType member: PERFORMANCE (the Core Web Vitals budget plugin).
--
-- Alone in its own migration, for the same reason the MOBILE one was: Postgres
-- will not let a value added by ALTER TYPE ... ADD VALUE be *used* by any other
-- statement in the same transaction, and Prisma runs one migration file in one
-- transaction. Keeping it separate means any migration that follows can
-- reference enum values freely.
-- IF NOT EXISTS keeps it re-runnable against a database where an operator
-- already added it by hand.
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'PERFORMANCE';
