#!/usr/bin/env tsx
/**
 * Fail the build when a Prisma enum and its TypeScript twin drift apart.
 *
 * `packages/shared/src/constants.ts` has advertised this script by name since
 * the beginning — "npm run check:enums fails the build when they drift" — and
 * the file did not exist, so `npm run check:enums` died with MODULE_NOT_FOUND
 * and nothing enforced the parity every plugin lookup depends on.
 *
 * It was not hypothetical. Five TestType members were added to the Prisma
 * schema and to constants.ts, and the database itself was left five values
 * behind; the mismatch was invisible until a row was written. This script
 * compares all three: the schema, the TS constants, and — when a database is
 * reachable — the live enum.
 *
 * Exit 1 on any drift, so CI stops rather than shipping a type whose rows
 * cannot be inserted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// The repo-root .env, same file and same path the API itself loads. Without
// this the live-database check silently skips — which is precisely the check
// that would have caught the five un-migrated enum values.
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const SCHEMA = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const CONSTANTS = fileURLToPath(new URL('../../../packages/shared/src/constants.ts', import.meta.url));
const TYPES = fileURLToPath(new URL('../../../packages/shared/src/types.ts', import.meta.url));

/**
 * Enums that must exist identically on both sides, and the TS declaration that
 * mirrors each.
 *
 * `kind` matters: most mirrors are a `const X = [...] as const` array, but
 * RunShardStatus is a union TYPE. It was added after this script existed and
 * landed outside it — the newest enum in the repo was the one enum the drift
 * guard could not see, which is exactly the hole this script was written to
 * close.
 */
const PAIRS: Array<{
  prismaEnum: string;
  tsConst: string;
  source?: 'constants' | 'types';
  kind?: 'array' | 'union';
}> = [
  { prismaEnum: 'TestType', tsConst: 'TEST_TYPES' },
  { prismaEnum: 'Verdict', tsConst: 'VERDICTS' },
  { prismaEnum: 'Language', tsConst: 'LANGUAGES' },
  { prismaEnum: 'RunShardStatus', tsConst: 'RunShardStatus', source: 'types', kind: 'union' },
];

function prismaEnumMembers(source: string, name: string): string[] | null {
  const block = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(source);
  if (!block) return null;
  return block[1]!
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

function tsConstMembers(source: string, name: string): string[] | null {
  // Matches `export const NAME = [ 'A', 'B' ] as const;`
  const block = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!block) return null;
  return [...block[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
}

/** Matches `export type Name = 'A' | 'B' | 'C';` across line breaks. */
function tsUnionMembers(source: string, name: string): string[] | null {
  const block = new RegExp(`export type ${name}\\s*=([^;]*);`).exec(source);
  if (!block) return null;
  const members = [...block[1]!.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);
  return members.length > 0 ? members : null;
}

const schema = readFileSync(SCHEMA, 'utf8');
const constants = readFileSync(CONSTANTS, 'utf8');
const types = readFileSync(TYPES, 'utf8');
const problems: string[] = [];

for (const { prismaEnum, tsConst, source = 'constants', kind = 'array' } of PAIRS) {
  const text = source === 'types' ? types : constants;
  const fromPrisma = prismaEnumMembers(schema, prismaEnum);
  const fromTs =
    kind === 'union' ? tsUnionMembers(text, tsConst) : tsConstMembers(text, tsConst);

  // A missing declaration is drift too — silently skipping it is how a renamed
  // enum stops being checked without anyone noticing.
  if (!fromPrisma) {
    problems.push(`enum ${prismaEnum} was not found in schema.prisma`);
    continue;
  }
  if (!fromTs) {
    problems.push(`${tsConst} was not found in ${source === 'types' ? 'types.ts' : 'constants.ts'}`);
    continue;
  }

  const onlyPrisma = fromPrisma.filter((v) => !fromTs.includes(v));
  const onlyTs = fromTs.filter((v) => !fromPrisma.includes(v));

  if (onlyPrisma.length > 0) {
    problems.push(`${prismaEnum}: in schema.prisma but not ${tsConst} — ${onlyPrisma.join(', ')}`);
  }
  if (onlyTs.length > 0) {
    problems.push(`${tsConst}: in TypeScript but not enum ${prismaEnum} — ${onlyTs.join(', ')}`);
  }
}

/*
 * The third source of truth, and the one that actually broke: the running
 * database. Prisma and TS can agree perfectly while the deployed enum is behind,
 * and the only symptom is an insert failing at run time. Checked only when a
 * database is reachable, so this stays useful on a machine with no Postgres.
 */
async function checkLiveDatabase(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('· DATABASE_URL not set — skipped the live enum check.');
    return;
  }
  let Client: typeof import('pg').Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    console.log('· pg not installed — skipped the live enum check.');
    return;
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch {
    console.log('· database unreachable — skipped the live enum check.');
    return;
  }

  try {
    for (const { prismaEnum } of PAIRS) {
      const declared = prismaEnumMembers(schema, prismaEnum) ?? [];
      const { rows } = await client.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = $1`,
        [prismaEnum],
      );
      if (rows.length === 0) continue; // the type does not exist here yet
      const live = rows.map((r) => r.enumlabel);
      const missing = declared.filter((v) => !live.includes(v));
      if (missing.length > 0) {
        problems.push(
          `${prismaEnum}: declared in schema.prisma but MISSING FROM THE DATABASE — ` +
            `${missing.join(', ')}. Run \`prisma migrate deploy\`; until then, inserting one of ` +
            `these fails at run time.`,
        );
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

await checkLiveDatabase();

if (problems.length > 0) {
  console.error('Enum drift:\n' + problems.map((p) => `  ✗ ${p}`).join('\n'));
  process.exit(1);
}

console.log(`✓ ${PAIRS.length} enum(s) match across schema.prisma, constants.ts and the database.`);
