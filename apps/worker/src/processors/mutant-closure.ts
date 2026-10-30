/**
 * Surviving mutants → the thing to assert, for one run.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `packages/agent/src/mutant-closure.ts` is 766 lines that turn `MutationSurvivor`
 * rows into ranked, de-duplicated, fenced work — and its only importer was
 * `packages/agent/src/index.ts` plus its own test. A barrel export with a
 * colocated test satisfies `scripts/check-wiring.ts`'s ratchet and reaches NO
 * REQUEST: "it has tests" is not a read path. So the mutation plugin kept
 * naming each missing assertion ("`>` became `>=` at src/cart.ts:84 and every
 * test still passed"), the rows kept landing, and the most precise instruction
 * this product generates went into a table, scored a percentage, and stopped.
 *
 * This is the consumer. It is reached from `apps/worker/src/index.ts`, which
 * asks for one of these after every run (`requestMutantClosure`), de-duplicated
 * by `mutant-closure:<runId>`.
 *
 * ── NO MODEL, AND NONE NEEDED ───────────────────────────────────────────────
 *
 * `mutantClosure` is a table lookup, a sort and some arithmetic. There is no
 * enrichment step here and no place for one: every sentence in the report is
 * composed from `MUTANT_BEHAVIOUR_RULES` and from numbers.
 *
 * ── WHAT IS DELIBERATELY NOT STORED, AND WHY IT IS SAID OUT LOUD ────────────
 *
 * `file`, `mutator` and `detail` all come out of a third-party mutation tool
 * reading the customer's own repository, so all three are untrusted text.
 * `mutantClosure` already fences `detail` and bounds `mutator`; this processor
 * stores the DETERMINISTIC fields and the bounded operator echoes and OMITS the
 * fenced tool prose, because copying untrusted prose into an audit row that
 * other surfaces render is more attack surface for no new information — the
 * survivor rows are still in the database, bounded, where the run page already
 * reads them. The omission is recorded IN the stored metadata
 * (`toolDetailOmitted`), because a reader who assumed the report carried the
 * tool's own words would be reading a truncated record as a complete one.
 *
 * Nothing untrusted decides anything: not a file path this writes to, not a
 * query, not whether a gate passes. The only thing `file` does here is travel
 * as a string.
 */

import { mutantClosure } from '@qaai/agent';
import type { MutantClosureReport, MutationSurvivorRow } from '@qaai/agent';
import type { MutantClosureJob } from '../queues.js';
import { logger, prisma } from '../context.js';

/**
 * The audit action this writes.
 *
 * A LOCAL CONSTANT and not an entry in `packages/shared/src/constants.ts`
 * beside `HEAL_AUDIT_ACTIONS` and `FLAKE_AUDIT_ACTIONS`, for the same reason
 * `VERIFY_HEAL_QUEUE` is a local literal: this change does not own that file.
 * `AuditLog.action` is a String by schema ("project.create", "verdict.override"),
 * so the shape matches the rows already there. Promoting it is in the handover.
 */
export const MUTANT_CLOSURE_AUDIT_ACTION = 'mutation.closure';

/**
 * How many survivor rows one job reads.
 *
 * The run processor itself caps what it PERSISTS at `MAX_PERSISTED_SURVIVORS`
 * (500) per test result, and a run has many results — so this needs a cap of
 * its own, and the cap has to be DISCLOSED when it bites, because a closure
 * report computed over the first 2000 of 9000 survivors is a floor and would
 * otherwise read as the whole report.
 */
export const MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT = 2_000;

/**
 * How many items are stored in the audit row.
 *
 * `mutantClosure` already caps its own item list at `MUTANT_CLOSURE_MAX_ITEMS`
 * (50) and reports `itemsTotal` beside it. This is a second, tighter bound on
 * what goes into a JSONB column — an audit row is read by the audit screen, not
 * by a work queue, and `itemsTotal` travels with it so the stored list cannot
 * be mistaken for all of them.
 */
export const MUTANT_CLOSURE_STORED_ITEMS = 20;

/** Everything this processor needs from the database, as narrow methods. */
export interface MutantClosureStore {
  /**
   * The run's surviving mutants, oldest first, at most `take`.
   *
   * `take` is the caller's cap + 1 so the caller can SEE it bite rather than
   * inferring it from a length that happens to equal the limit.
   */
  survivorsForRun(args: {
    orgId: string;
    runId: string;
    take: number;
  }): Promise<MutationSurvivorRow[]>;
  /** The one durable record this job leaves. */
  recordReport(args: {
    orgId: string;
    runId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

/** Just enough logger to be satisfied by pino and by a two-line fake. */
export interface ClosureLog {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const CLOSURE_OUTCOMES = [
  /** A report was computed and the audit row written. */
  'REPORTED',
  /**
   * The run has no surviving mutants.
   *
   * Its own member, and NOT folded into REPORTED with zeros: "this run ran no
   * mutation test" and "this run's mutation test found nothing to close" are
   * different facts, and only the second is a statement about the suite. Both
   * land here because this processor cannot tell them apart from the survivor
   * table alone, and the sentence says exactly that rather than claiming the
   * flattering one.
   */
  'NOTHING_TO_CLOSE',
] as const;
export type ClosureOutcome = (typeof CLOSURE_OUTCOMES)[number];

export interface MutantClosureResult {
  readonly outcome: ClosureOutcome;
  /** Survivor rows read. A FLOOR when `capped` is true. */
  readonly survivors: number;
  /**
   * TRUE when {@link MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT} bit.
   *
   * A cap applied without being disclosed is one of the lies this product
   * cannot afford, and the reason reported is the one that actually bit.
   */
  readonly capped: boolean;
  /** Null when nothing was computed. Never a zeroed report standing in for one. */
  readonly report: MutantClosureReport | null;
  /** The sentence an operator reads. Composed from counts, never from the tool. */
  readonly note: string;
}

/**
 * Turn one run's surviving mutants into closure items, and record them.
 *
 * `deps` is the test seam and defaults to the production ports, which is the
 * same shape every other processor in this directory uses.
 */
export async function processMutantClosure(
  job: MutantClosureJob,
  deps: { store?: MutantClosureStore; log?: ClosureLog } = {},
): Promise<MutantClosureResult> {
  const store = deps.store ?? livePorts();
  const log = deps.log ?? logger;

  const rows = await store.survivorsForRun({
    orgId: job.orgId,
    runId: job.runId,
    take: MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT + 1,
  });
  const capped = rows.length > MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT;
  const survivors = capped ? MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT : rows.length;

  if (survivors === 0) {
    const note =
      'No surviving mutants are recorded for this run. Either it ran no mutation test, or the one it ran reported nothing — this job cannot tell those apart, so neither is claimed.';
    log.info({ runId: job.runId, reason: job.reason, survivors: 0 }, note);
    return { outcome: 'NOTHING_TO_CLOSE', survivors: 0, capped: false, report: null, note };
  }

  const report = mutantClosure({ survivors: rows.slice(0, survivors) });

  /*
   * The cap and the REASON, together and in the stored row. `survivors` is a
   * floor when `capped` is true, and every count derived from it — including
   * the class histogram and `itemsTotal` — is a floor with it.
   */
  const note = capped
    ? `${report.disclosure} Computed over the first ${MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT} survivor row(s) of this run because the scan cap bit, so every count here is a floor.`
    : report.disclosure;

  await store.recordReport({
    orgId: job.orgId,
    runId: job.runId,
    metadata: {
      reason: job.reason,
      survivorsRead: survivors,
      survivorScanCapped: capped,
      survivorScanCappedAt: capped ? MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT : null,
      classified: report.classified,
      notGenerated: report.notGenerated,
      itemsTotal: report.itemsTotal,
      itemsStored: Math.min(report.items.length, MUTANT_CLOSURE_STORED_ITEMS),
      itemsCappedAt: report.cappedAt,
      unknownMutators: report.unknownMutators,
      unknownMutatorCount: report.unknownMutatorCount,
      disclosure: note,
      caveats: report.caveats,
      /*
       * TRUE always, and stated rather than implied. The fenced tool prose is
       * NOT copied into this row (see the header), and a reader who assumed it
       * was would read a deliberate omission as "the tool said nothing".
       */
      toolDetailOmitted: true,
      items: report.items.slice(0, MUTANT_CLOSURE_STORED_ITEMS).map((item) => ({
        id: item.id,
        need: item.need,
        class: item.class,
        behaviour: item.behaviour,
        // Customer-authored text, stored as DATA. Never normalised (a rewritten
        // path does not open) and never used to compose an instruction.
        file: item.file,
        lines: item.lines,
        lineCount: item.lineCount,
        survivors: item.survivors,
        missingAssertion: item.missingAssertion,
        where: item.where,
        rank: item.rank,
        reportedMutators: item.reportedMutators,
        testResultIds: item.testResultIds,
      })),
    },
  });

  log.info(
    {
      runId: job.runId,
      reason: job.reason,
      survivors,
      capped,
      cappedAt: capped ? MUTANT_CLOSURE_SURVIVOR_SCAN_LIMIT : null,
      items: report.itemsTotal,
      classified: report.classified,
      unknownMutatorCount: report.unknownMutatorCount,
    },
    note,
  );

  return { outcome: 'REPORTED', survivors, capped, report, note };
}

/**
 * The production ports.
 *
 * Narrow methods and not a Prisma client, for the reason that cost this build
 * two slices: a fake that ignores `select` makes deleting a field from a query
 * undetectable. There is no `select` here for a fake to be blind to — the
 * projection is the return type, and dropping a field from it is a compile
 * error at every reader.
 */
function livePorts(): MutantClosureStore {
  return {
    async survivorsForRun({ orgId, runId, take }) {
      /*
       * Through the result, because `MutationSurvivor` carries `testResultId`
       * and not `runId` — the row belongs to one test's report. Ordered oldest
       * first so the cap, when it bites, always takes the same prefix: a cap
       * over an unstable order would make the report move between two runs of
       * the same job for no reason the reader could see.
       */
      const rows = await prisma.mutationSurvivor.findMany({
        where: { orgId, testResult: { runId } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
        select: {
          id: true,
          file: true,
          line: true,
          mutator: true,
          detail: true,
          reason: true,
          testResultId: true,
        },
      });
      return rows;
    },
    async recordReport({ orgId, runId, metadata }) {
      await prisma.auditLog.create({
        data: {
          orgId,
          // No user: this is the loop acting on its own measurement.
          userId: null,
          action: MUTANT_CLOSURE_AUDIT_ACTION,
          targetType: 'Run',
          targetId: runId,
          metadata: metadata as never,
        },
      });
    },
  };
}

/**
 * Ask for a run's mutation report to be closed, and never throw.
 *
 * NEVER THROWS, which is what makes an `await` inside the run registration's
 * `finally` safe: a throw there would REPLACE the error the run actually failed
 * with, and a Redis blip would be reported as a run failure. Same contract as
 * `requestRecompute` and `requestStyleProfile`, which that `finally` already
 * holds, and it is stated here because the call site relies on it.
 */
export async function requestMutantClosure(args: {
  orgId: string;
  runId: string;
  reason: MutantClosureJob['reason'];
}): Promise<boolean> {
  try {
    // Imported here rather than at the top: queues.ts constructs BullMQ Queue
    // objects at module load, and this module's tests must not open Redis.
    const { enqueueMutantClosure } = await import('../queues.js');
    await enqueueMutantClosure({ orgId: args.orgId, runId: args.runId, reason: args.reason });
    return true;
  } catch (err) {
    logger.error({ err, runId: args.runId }, 'could not request a mutant-closure report');
    return false;
  }
}
