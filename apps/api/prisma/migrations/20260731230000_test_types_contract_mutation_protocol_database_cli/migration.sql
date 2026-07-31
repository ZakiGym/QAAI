-- Five new TestType members: DATABASE, CLI, PROTOCOL, CONTRACT, MUTATION.
--
-- Each ALTER TYPE ... ADD VALUE is its own statement and Postgres will not run
-- them inside a transaction block alongside other work, which is why this
-- migration contains nothing else. IF NOT EXISTS keeps it re-runnable against a
-- database where an operator already added one by hand.
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'DATABASE';
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'CLI';
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'PROTOCOL';
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'CONTRACT';
ALTER TYPE "TestType" ADD VALUE IF NOT EXISTS 'MUTATION';
