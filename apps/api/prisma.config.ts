/**
 * Prisma 7 config. Migrate reads the connection URL from here; the runtime
 * client gets it through the pg driver adapter in `src/lib/prisma.ts`.
 */
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// One .env at the repo root serves every workspace.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://qaai:qaai@localhost:5432/qaai?schema=public',
  },
});
