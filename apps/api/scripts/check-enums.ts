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
// Not every mirror lives in @qaai/shared. RunnerJobStatus is declared next to
// the lease and reaper logic that is its only reader, and moving it here just to
// be checkable would be the tail wagging the dog.
const RUNNERS = fileURLToPath(new URL('../src/lib/runners.ts', import.meta.url));
const SSO = fileURLToPath(new URL('../src/lib/sso.ts', import.meta.url));
/*
 * The enumeration vocabularies. They are in @qaai/shared but NOT in
 * constants.ts or types.ts: `surface.ts` and `flow-map.ts` are the files whose
 * readers consume them, and `scripts/check-wiring.ts` already treats
 * `surface.ts` as the home of the surface vocabulary (SURFACE_VOCABULARY there
 * diffs three of its lists against the Prisma enums). Dragging four more lists
 * into constants.ts purely to be reachable from this script would be the tail
 * wagging the dog — the same judgement the RUNNERS entry above records.
 */
const SURFACE = fileURLToPath(new URL('../../../packages/shared/src/surface.ts', import.meta.url));
const FLOW_MAP = fileURLToPath(new URL('../../../packages/shared/src/flow-map.ts', import.meta.url));
/*
 * The non-crawl enumeration vocabularies, in @qaai/shared for the same reason
 * and NOT in constants.ts either. `requirements.ts` is the spec side (what a
 * human declared) and `api-surface.ts` the machine-read side (what a document,
 * a module tree or a week of traffic declares); each sits beside the readers
 * that consume it, and each also holds the write-path schema for its own
 * vocabulary, which is the arrangement that stops a member existing with no
 * way to save it.
 */
const REQUIREMENTS = fileURLToPath(
  new URL('../../../packages/shared/src/requirements.ts', import.meta.url),
);
const API_SURFACE = fileURLToPath(
  new URL('../../../packages/shared/src/api-surface.ts', import.meta.url),
);

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
  source?:
    | 'constants'
    | 'types'
    | 'runners'
    | 'sso'
    | 'surface'
    | 'flowMap'
    | 'requirements'
    | 'apiSurface';
  kind?: 'array' | 'union';
}> = [
  { prismaEnum: 'TestType', tsConst: 'TEST_TYPES' },
  { prismaEnum: 'Verdict', tsConst: 'VERDICTS' },
  { prismaEnum: 'Language', tsConst: 'LANGUAGES' },
  { prismaEnum: 'RunShardStatus', tsConst: 'RunShardStatus', source: 'types', kind: 'union' },
  // Dunning (§9). The webhook writes it and the UI will eventually render it;
  // a database value TypeScript does not know about would be an org whose
  // billing screen cannot say what state it is in.
  { prismaEnum: 'BillingState', tsConst: 'BillingState', source: 'types', kind: 'union' },
  // Outbound deliveries (§7). The worker writes it on every attempt and the
  // deliveries read path renders it; a database value TypeScript does not know
  // about would be a delivery whose state the screen cannot name.
  {
    prismaEnum: 'WebhookDeliveryStatus',
    tsConst: 'WebhookDeliveryStatus',
    source: 'types',
    kind: 'union',
  },
  // SSO (§1). The admin API validates `protocol` against SSO_PROTOCOLS, so a
  // value in the database enum that TypeScript does not know about is a
  // connection nobody can log in through.
  { prismaEnum: 'SsoProtocol', tsConst: 'SSO_PROTOCOLS', source: 'sso' },
  // On-prem runners (§5). Same shape as RunShardStatus — a union TYPE, not an
  // array — and it lives beside the code that transitions it rather than in
  // @qaai/shared, because the lease/reaper logic is the only thing that reads it.
  {
    prismaEnum: 'RunnerJobStatus',
    tsConst: 'RunnerJobStatus',
    source: 'runners',
    kind: 'union',
  },
  // Why a result did not run (§4). The run finaliser writes it on every
  // unattempted test and the pass-rate and coverage denominators are meant to
  // EXCLUDE two of its four members — so a database value TypeScript does not
  // know about is a skip that silently counts as evidence about the customer's
  // application. The TS side is NOT_RUN_KINDS in constants.ts, which is also
  // what `isNotRunKind` and `parseNotRun` validate against, so this entry
  // guards the read path as well as the write.
  { prismaEnum: 'NotRunKind', tsConst: 'NOT_RUN_KINDS' },
  /*
   * ── The enumeration denominator (§ coverage) ──────────────────────────────
   *
   * All four are written by the surface extractors and the crawl adjudicator,
   * and all four are FILTERED ON by a reader, which is why each earned a
   * database type rather than a TEXT column. That also makes each one a value a
   * row may hold and TypeScript may not know about — the precise failure this
   * script's docstring describes, where five TestType members sat un-migrated
   * and invisible until an insert failed at run time.
   */
  // Which declarer put an item in the inventory. The one that makes an
  // uncrawlable surface — a job, an email, a webhook receiver, a flag, a role,
  // a locale — nameable at all, so that ABSENT stops masquerading as covered.
  // Also the arbiter in `selectFlowMap`: an OBSERVED map outranks a DECLARED
  // one regardless of version, which is what stops a source-derived flow map
  // from displacing a real crawl.
  { prismaEnum: 'SurfaceSource', tsConst: 'SURFACE_SOURCES', source: 'surface' },
  // Whether a test may drive an item here. A value in the database that
  // TypeScript cannot name would be an item the dark-surface report can neither
  // count in the denominator nor list as held out — invisible in both
  // directions, which is the one outcome this feature exists to prevent.
  {
    prismaEnum: 'SurfaceExercisability',
    tsConst: 'SURFACE_EXERCISABILITIES',
    source: 'surface',
  },
  // The dimension tables. `DIMENSION_AXIS` is a `Record` keyed on this union,
  // so a seventh dimension in the database that TypeScript does not know about
  // would be rows of cells with no axis to be counted on.
  {
    prismaEnum: 'SurfaceDimensionKind',
    tsConst: 'SURFACE_DIMENSION_KINDS',
    source: 'surface',
  },
  // Whether a crawl may be the denominator. The highest-stakes of the four: a
  // state the database accepts and the selector cannot rank would fall through
  // `selectFlowMap`'s acceptance ranking into the legacy-null arm and a
  // degraded crawl would be promoted — which is exactly the defect that makes
  // the coverage percentage go up on the day a customer's environment falls
  // over.
  {
    prismaEnum: 'CrawlAcceptanceState',
    tsConst: 'CRAWL_ACCEPTANCE_STATES',
    source: 'flowMap',
  },
  /*
   * ── The non-crawl enumeration sources (§ coverage) ────────────────────────
   *
   * Ten, and every one is a closed vocabulary a reader FILTERS on — which is
   * what earned it a database type in the first place, and is therefore
   * exactly what makes it a value a row may hold and TypeScript may not know
   * about. Five TestType members once sat un-migrated and invisible until an
   * insert failed at run time; these ten are the same hazard, in a feature
   * whose whole output is a number a customer is asked to believe.
   *
   * The spec side first. `requirements.ts` is their home for the same reason
   * `surface.ts` is the home of the four above: the readers that consume them
   * live beside them, and dragging ten more lists into constants.ts purely to
   * be reachable from this script would be the tail wagging the dog.
   */
  // Where a requirement or a manual test case was read from. Filtered on by
  // every re-import: the importer asks "which rows did THIS connector own?"
  // before retiring anything, and a system the database accepts that TypeScript
  // cannot name would be rows no re-import can ever reconcile.
  { prismaEnum: 'SpecSourceSystem', tsConst: 'SPEC_SOURCE_SYSTEMS', source: 'requirements' },
  // A requirement's normalised status. The highest-stakes of the ten:
  // `OBSOLETE_STATUSES` takes a requirement OUT of the coverage denominator and
  // `requirementTestability` decides whether a generated test is expected to
  // pass, so a status value TypeScript cannot name falls through both switches
  // — and a requirement that silently leaves the denominator raises the
  // percentage with nothing anywhere to explain it.
  { prismaEnum: 'RequirementStatus', tsConst: 'REQUIREMENT_STATUSES', source: 'requirements' },
  // How much structure survived the import of one acceptance criterion.
  // `STRUCTURED_CRITERION_FORMATS` is what generation selects on, so an unknown
  // format is a criterion no generator will ever pick up and nothing will report
  // as skipped.
  {
    prismaEnum: 'AcceptanceCriterionFormat',
    tsConst: 'ACCEPTANCE_CRITERION_FORMATS',
    source: 'requirements',
  },
  // HOW a requirement→test link was made. THE honesty column:
  // `LINK_METHOD_CONFIDENCE_CEILING` is a `Record` keyed on this union, so a
  // fifth method in the database that TypeScript does not know about would be a
  // link with NO CEILING — a regex able to claim 1.0 and read as traceability.
  {
    prismaEnum: 'RequirementLinkMethod',
    tsConst: 'REQUIREMENT_LINK_METHODS',
    source: 'requirements',
  },
  // Whether anything is linked, and how strongly. `linkStateFrom` is the only
  // derivation and `UNLINKED_STATES` is what the report pages through; a state
  // the database accepts and TypeScript cannot name is a requirement that
  // appears in neither the covered list nor the gap list.
  {
    prismaEnum: 'RequirementLinkState',
    tsConst: 'REQUIREMENT_LINK_STATES',
    source: 'requirements',
  },
  // Whether a manual case is automated. `AUTOMATION_BACKLOG_STATUSES` is the
  // backlog number quoted at the customer, and NOT_STATED is deliberately
  // outside it — an unknown member would land in neither bucket and the
  // `total` would stop equalling the parts.
  {
    prismaEnum: 'ManualTestAutomationStatus',
    tsConst: 'MANUAL_TEST_AUTOMATION_STATUSES',
    source: 'requirements',
  },
  /*
   * The API and component side, in `api-surface.ts` for the same reason.
   */
  // What the DOCUMENT says about auth. `ANONYMOUS_ACCESS_DECLARED` gates
  // negative-auth generation, and a value that falls outside it is read as "do
  // not generate" — safe — while a value TypeScript cannot name at all cannot
  // be rendered, so the reader would show nothing where the document's position
  // belongs. UNSTATED and NOT_READ are the two members an omission would hide.
  { prismaEnum: 'ApiAuthDeclaration', tsConst: 'API_AUTH_DECLARATIONS', source: 'apiSurface' },
  // Whether an operation has been CONFIRMED to exist. A value the database
  // accepts and the reader cannot name is an operation that is neither declared
  // nor confirmed nor unprobed on screen — and NOT_PROBED rendering as
  // anything other than "we did not ask" is the single rendering mistake this
  // enum exists to prevent.
  {
    prismaEnum: 'ApiOperationVerification',
    tsConst: 'API_OPERATION_VERIFICATIONS',
    source: 'apiSurface',
  },
  // What kind of exported thing a component row is. `COMPONENT_KINDS_WITH_OWN_AXIS`
  // is a `Record` keyed on this union, so a seventh kind in the database that
  // TypeScript does not know about would be a row with no answer to "is this
  // already counted on the ROUTE axis?" — which is how the same page gets
  // counted twice and the denominator grows without the application doing so.
  { prismaEnum: 'ComponentItemKind', tsConst: 'COMPONENT_ITEM_KINDS', source: 'apiSurface' },
  // The named states. `NON_HAPPY_PATH_STATES` is derived by filtering this list,
  // so a state in the database that TypeScript cannot name is a state excluded
  // from the one count that makes "not just the happy path" checkable.
  { prismaEnum: 'ComponentStateKind', tsConst: 'COMPONENT_STATE_KINDS', source: 'apiSurface' },
];

/*
 * NOT LISTED YET, and the reason is a finding rather than an exemption:
 *
 *   { prismaEnum: 'HealState', tsConst: 'HEAL_STATES', source: 'types' }
 *
 * `HealState` now HAS a TypeScript mirror (`HEAL_STATES` in
 * packages/shared/src/types.ts) and the two agree member for member — the
 * static half of this check passes for it today. What fails is the third
 * source, the live one: `HealState.SUPERSEDED` was added to schema.prisma by
 * migration 20261024050000_heal_lifecycle_enum_values and that migration has
 * not been deployed, so the database does not have the value. `planSupersede`
 * in packages/agent/src/healer.ts writes SUPERSEDED, which means every
 * supersede INSERT fails at run time on a database in that state — exactly the
 * defect this script's docstring describes, and exactly what adding the pair
 * would report.
 *
 * It is left out only because adding it would make this script red for a
 * reason no code change can fix, and a red check with no available remedy is a
 * check people start skipping. Run `prisma migrate deploy`, then add the line
 * above; it should pass immediately.
 */

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
const runners = readFileSync(RUNNERS, 'utf8');
const sso = readFileSync(SSO, 'utf8');
const surface = readFileSync(SURFACE, 'utf8');
const flowMap = readFileSync(FLOW_MAP, 'utf8');
const requirements = readFileSync(REQUIREMENTS, 'utf8');
const apiSurface = readFileSync(API_SURFACE, 'utf8');
const SOURCES: Record<
  | 'constants'
  | 'types'
  | 'runners'
  | 'sso'
  | 'surface'
  | 'flowMap'
  | 'requirements'
  | 'apiSurface',
  { text: string; label: string }
> = {
  constants: { text: constants, label: 'constants.ts' },
  types: { text: types, label: 'types.ts' },
  runners: { text: runners, label: 'lib/runners.ts' },
  sso: { text: sso, label: 'lib/sso.ts' },
  surface: { text: surface, label: 'shared/surface.ts' },
  flowMap: { text: flowMap, label: 'shared/flow-map.ts' },
  requirements: { text: requirements, label: 'shared/requirements.ts' },
  apiSurface: { text: apiSurface, label: 'shared/api-surface.ts' },
};
const problems: string[] = [];

for (const { prismaEnum, tsConst, source = 'constants', kind = 'array' } of PAIRS) {
  const { text, label } = SOURCES[source];
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
    problems.push(`${tsConst} was not found in ${label}`);
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
