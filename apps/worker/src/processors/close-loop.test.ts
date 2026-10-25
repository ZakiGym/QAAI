/**
 * Tests for the close-the-gaps loop.
 *
 * This is the one component in the product that spends money without being
 * asked — every item it proposes is a model call and eventually a browser — so
 * it is judged on two axes and the first is not correctness:
 *
 *   1. IT MUST STOP. Seven of the eight branches of `decideTick` are exits, and
 *      each one is tested on its own, because a loop whose own output decides
 *      whether it runs again is the shape of every runaway worker ever written.
 *      The specific case the task named — "a project whose coverage cannot
 *      move" — is the UNMEASURABLE test: it must stop on the FIRST tick rather
 *      than discover 24 times that zero minus zero is small.
 *   2. IT MUST NOT FLATTER ITSELF. A gap absent from a report because the crawl
 *      failed, or because the report was a ranked page, is NOT a closed gap.
 *      That rule lives in `verifyClosure` (tested in packages/agent) and this
 *      file proves the processor actually asks it, with the right evidence.
 *
 * NOTHING HERE NEEDS A MODEL KEY, and that is an assertion rather than a
 * convenience: every deterministic path — the measurement, the ranking, the
 * plan items read off the crawl, the ledger, the stop rules — works with no
 * model call at all, and `generatorAvailable: false` is a tested branch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverageGap } from '@qaai/agent';

type Row = Record<string, any>;

interface Hoisted {
  prisma: Record<string, unknown>;
  log: Array<{ level: string; msg: string; obj: Row }>;
  generates: Row[];
  explores: Row[];
  exploreThrows: Error | null;
}

// The worker's context opens Postgres, Redis and the LLM at import time, and
// `queues.ts` builds its BullMQ producers at import time too, so both are
// replaced wholesale.
const h = vi.hoisted((): Hoisted => ({
  prisma: {},
  log: [],
  generates: [],
  explores: [],
  exploreThrows: null,
}));

vi.mock('../context.js', () => {
  const record =
    (level: string) =>
    (obj: Row, msg?: string): void => {
      h.log.push({ level, msg: msg ?? '', obj });
    };
  return {
    // Empty, so `config.anthropicApiKey` is falsy unless a test injects
    // `generatorAvailable`. A suite that silently depended on a key being
    // present in the developer's shell would pass locally and fail in CI.
    config: {},
    connection: {},
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    prisma: new Proxy({}, { get: (_t, key: string) => h.prisma[key] }),
  };
});

vi.mock('../queues.js', () => ({
  enqueueGenerate: async (job: Row) => {
    h.generates.push(job);
  },
  enqueueExplore: async (job: Row) => {
    if (h.exploreThrows) throw h.exploreThrows;
    h.explores.push(job);
  },
}));

const {
  CLOSE_LOOP_MAX_TICKS,
  CLOSE_LOOP_RECRAWL_AFTER_MS,
  CLOSE_LOOP_RECRAWL_MAX_DEPTH,
  CLOSE_LOOP_RECRAWL_MAX_PAGES,
  CLOSE_LOOP_SETTLE_DELTA_POINTS,
  CLOSE_LOOP_SETTLE_TICKS,
  CLOSE_LOOP_SWEEP_LIMIT,
  CLOSE_LOOP_TICK_MS,
  advanceClosureCampaigns,
  approvalPolicyOf,
  dayKeyOf,
  decideTick,
  pastTickCeiling,
  processCloseLoopTick,
} = await import('./close-loop.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-24T03:00:00.000Z');

function gap(over: Partial<CoverageGap> & { id: string }): CoverageGap {
  return {
    kind: 'UNVISITED_ROUTE',
    title: `Nothing covers ${over.id}`,
    route: `/${over.id}`,
    feature: 'Orders',
    evidence: ['The crawl reached this route from 3 places; no test mentions it.'],
    confidence: 'HIGH',
    reachability: 0.5,
    blastRadius: 0.5,
    score: 50,
    scoreWhy: ['reached from 3 places'],
    relatedTestIds: [],
    requiresAuth: false,
    authProfile: null,
    subject: {
      kind: 'route',
      route: `/${over.id}`,
      title: `Nothing covers ${over.id}`,
      behindAuth: false,
      forms: [],
      entryActions: [],
    },
    ...over,
  };
}

const tickInput = (over: Partial<Parameters<typeof decideTick>[0]> = {}) => ({
  tick: 1,
  percent: 40,
  previousPercent: null,
  settledTicks: 0,
  targetPercent: 80,
  itemsProposed: 0,
  nightlyItemBudget: 40,
  topK: 8,
  selectable: 10,
  pendingGeneration: 0,
  generatorAvailable: true,
  ...over,
});

const campaign = (over: Row = {}) => ({
  id: 'camp_1',
  orgId: 'org_1',
  projectId: 'proj_1',
  dayKey: '2026-10-24',
  targetPercent: 80,
  topK: 2,
  nightlyItemBudget: 40,
  approvalPolicy: 'HUMAN_REVIEW',
  tick: 0,
  itemsProposed: 0,
  settledTicks: 0,
  lastPercent: null,
  lastSnapshotId: null,
  recrawlQueuedAt: null,
  ...over,
});

// ─── The in-memory client ────────────────────────────────────────────────────

interface Store {
  projects: Row[];
  campaigns: Row[];
  closures: Row[];
  planItems: Row[];
  tests: Row[];
  plans: Row[];
  /**
   * Statements issued against the ledger, counted.
   *
   * Here because "one awaited UPDATE per ledger row, in series, inside the
   * 60-second scheduler tick" is a defect no assertion about row VALUES can
   * see: the values were right all along. Counting is the only way a test can
   * tell a batch from a loop.
   */
  writes: { closureUpdate: number; closureUpdateMany: number };
}

let store: Store;

/** `{ increment: n }` is the only operator the processor writes. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      row[key] = (row[key] ?? 0) + (value as Row).increment;
      continue;
    }
    row[key] = value;
  }
}

function makeDb(): Record<string, unknown> {
  return {
    /*
     * The ledger's writes go out in batches now, so the fake has to model the
     * batch. Two fidelity gaps are worth naming rather than discovering:
     * `$transaction` here is `Promise.all`, so it is not atomic; and the fake's
     * `update` runs when it is CALLED rather than when the transaction is
     * awaited, where the real client defers. Neither matters to what these
     * tests assert — which rows ended up with which values, and how many
     * statements it took — and `writes` is what makes the second half
     * checkable: a reconciliation that went back to one round trip per row
     * would push the count straight back up.
     */
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),

    project: {
      findMany: async ({ where = {}, take }: Row = {}) => {
        const found = store.projects.filter((project) => {
          if (where.archivedAt === null && project.archivedAt != null) return false;
          if (where.coverageTargetPercent?.not === null && project.coverageTargetPercent == null) {
            return false;
          }
          const dayKey = where.closureCampaigns?.none?.dayKey;
          if (dayKey && store.campaigns.some((c) => c.projectId === project.id && c.dayKey === dayKey)) {
            return false;
          }
          return true;
        });
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
    },

    closureCampaign: {
      createMany: async ({ data, skipDuplicates }: Row) => {
        let count = 0;
        for (const row of data as Row[]) {
          const clash = store.campaigns.some(
            (c) => c.projectId === row.projectId && c.dayKey === row.dayKey,
          );
          // The unique index IS the nightly budget; the fake has to enforce it
          // or the budget test would pass against a fake that cannot fail.
          if (clash) {
            if (skipDuplicates) continue;
            throw new Error('unique constraint: ClosureCampaign_projectId_dayKey_key');
          }
          store.campaigns.push({ id: `camp_${store.campaigns.length + 1}`, tick: 0, ...row });
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where = {}, take }: Row = {}) => {
        const found = store.campaigns.filter((c) => {
          if (where.state && c.state !== where.state) return false;
          const lte = where.nextTickAt?.lte;
          if (lte && !(c.nextTickAt && c.nextTickAt <= lte)) return false;
          return true;
        });
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const found = store.campaigns.filter((c) => {
          if (where.id && c.id !== where.id) return false;
          if (where.state && c.state !== where.state) return false;
          const lte = where.nextTickAt?.lte;
          if (lte && !(c.nextTickAt && c.nextTickAt <= lte)) return false;
          return true;
        });
        for (const row of found) applyData(row, data);
        return { count: found.length };
      },
      /*
       * Lenient on a row the test did not seed: it records the write instead of
       * throwing. The tests that assert on what the processor wrote push a row
       * and read it back; the ones that only care about the return value should
       * not need the boilerplate, and a fake that demanded it would fail them
       * with a message about itself rather than about the code under test.
       */
      update: async ({ where, data }: Row) => {
        let row = store.campaigns.find((c) => c.id === where.id);
        if (!row) {
          row = { id: where.id };
          store.campaigns.push(row);
        }
        applyData(row, data);
        return { ...row };
      },
    },

    gapClosure: {
      findMany: async ({ where = {} }: Row = {}) =>
        store.closures
          .filter((row) => {
            if (where.projectId && row.projectId !== where.projectId) return false;
            if (where.planItemId?.not === null && row.planItemId == null) return false;
            if (where.testId === null && row.testId != null) return false;
            return true;
          })
          .map((row) => ({ ...row })),
      update: async ({ where, data }: Row) => {
        store.writes.closureUpdate += 1;
        const row = store.closures.find((c) => c.id === where.id);
        if (!row) throw new Error(`no closure ${where.id}`);
        applyData(row, data);
        return { ...row };
      },
      updateMany: async ({ where = {}, data }: Row = {}) => {
        store.writes.closureUpdateMany += 1;
        const found = store.closures.filter((c) => !where.id?.in || where.id.in.includes(c.id));
        for (const row of found) applyData(row, data);
        return { count: found.length };
      },
      upsert: async ({ where, create, update }: Row) => {
        const key = where.projectId_gapId;
        const row = store.closures.find(
          (c) => c.projectId === key.projectId && c.gapId === key.gapId,
        );
        if (row) {
          applyData(row, update);
          return { ...row };
        }
        const made = {
          id: `clo_${store.closures.length + 1}`,
          reopenCount: 0,
          testId: null,
          planItemId: null,
          ...create,
        };
        store.closures.push(made);
        return { ...made };
      },
    },

    planItem: {
      findMany: async ({ where = {} }: Row = {}) =>
        store.planItems
          .filter((item) => !where.id?.in || where.id.in.includes(item.id))
          .map((row) => ({ ...row })),
    },

    test: {
      updateMany: async ({ where = {}, data }: Row = {}) => {
        const found = store.tests.filter((test) => {
          if (where.id && test.id !== where.id) return false;
          if (where.orgId && test.orgId !== where.orgId) return false;
          // First-writer-wins provenance: a test that already names a gap is
          // not relabelled.
          if (where.gapId === null && test.gapId != null) return false;
          return true;
        });
        for (const row of found) applyData(row, data);
        return { count: found.length };
      },
    },

    testPlan: {
      create: async ({ data }: Row) => {
        const { items, ...rest } = data as Row;
        const plan = { id: `plan_${store.plans.length + 1}`, ...rest };
        store.plans.push(plan);
        for (const item of items?.create ?? []) {
          store.planItems.push({ generatedTestId: null, ...item, testPlanId: plan.id });
        }
        return { id: plan.id };
      },
    },
  };
}

/** A recompute stub: reports a percent and the delta the processor asked for. */
function stubRecompute(percents: Array<number | null>) {
  const calls: Row[] = [];
  let index = 0;
  const recompute = vi.fn(async (job: Row) => {
    calls.push(job);
    const percent = percents[Math.min(index, percents.length - 1)] ?? null;
    index += 1;
    return {
      projectId: job.projectId as string,
      reason: job.reason as 'close-loop',
      snapshotId: `snap_${index}`,
      percent,
      denominator: percent === null ? 0 : 100,
      covered: 0,
      assertedNotRun: 0,
      uncovered: 0,
      unknown: 0,
      waived: 0,
      unmeasuredKinds: [],
      caveats: [],
      previousPercent: null,
      deltaPoints: null,
      deltaWhy: 'stub',
      headline: 'stub',
    };
  });
  return { recompute, calls };
}

function stubGapReport(over: Row = {}) {
  return async () => ({
    crawled: true,
    complete: true,
    gaps: [gap({ id: 'gap_a', score: 90 }), gap({ id: 'gap_b', score: 80 })],
    flowMapId: 'fm_1',
    flowMapVersion: 3,
    environmentId: 'env_1',
    flowMapCreatedAt: new Date(NOW.getTime() - 60_000),
    ...over,
  });
}

beforeEach(() => {
  h.log = [];
  h.generates = [];
  h.explores = [];
  h.exploreThrows = null;
  store = {
    projects: [],
    campaigns: [],
    closures: [],
    planItems: [],
    tests: [],
    plans: [],
    writes: { closureUpdate: 0, closureUpdateMany: 0 },
  };
  h.prisma = makeDb();
});

// ─── The stop rules ──────────────────────────────────────────────────────────

describe('decideTick stops, and says which of the seven reasons stopped it', () => {
  it('stops on the FIRST tick when coverage is not measurable at all', () => {
    /*
     * The case the task named: "a loop that re-queues itself on a project whose
     * coverage cannot move is a worker that never idles". A null percent is an
     * empty denominator — no source analysis and no crawl — so no test anyone
     * writes tonight can change it, and ticking 24 times to discover that is
     * 24 recomputes and 24 gap reports for nothing.
     */
    const decision = decideTick(tickInput({ percent: null, previousPercent: null }));

    expect(decision.state).toBe('UNMEASURABLE');
    expect(decision.again).toBe(false);
    expect(decision.itemBudget).toBe(0);
    expect(decision.deltaPoints).toBeNull();
    expect(decision.reason).toContain('not measured');
  });

  it('stops when the target is met', () => {
    const decision = decideTick(tickInput({ percent: 81, targetPercent: 80 }));
    expect(decision.state).toBe('TARGET_MET');
    expect(decision.again).toBe(false);
  });

  it('stops at the tick ceiling whatever every other rule thinks', () => {
    /*
     * Checked BEFORE the delta arithmetic deliberately: a stop that depends on
     * the delta being right is no protection against the delta being wrong, and
     * the delta is exactly where a bug would be.
     */
    const decision = decideTick(
      tickInput({ tick: CLOSE_LOOP_MAX_TICKS + 1, percent: 10, previousPercent: 0 }),
    );
    expect(decision.state).toBe('TICK_CEILING');
    expect(decision.again).toBe(false);
  });

  /*
   * `stop` is documented as FREEZING `settledTicks` rather than zeroing it —
   * "the count is part of why the campaign stopped and zeroing it would erase
   * the evidence for its own decision" — and nothing asserted it, so the
   * reset was a one-character change away on every one of the seven exits.
   */
  it('freezes the settle count on the way out instead of erasing it', () => {
    for (const over of [
      { percent: null },
      { percent: 81, targetPercent: 80 },
      { tick: CLOSE_LOOP_MAX_TICKS + 1 },
      { itemsProposed: 40, nightlyItemBudget: 40 },
      { selectable: 0 },
    ]) {
      const decision = decideTick(tickInput({ settledTicks: 1, ...over }));
      expect(decision.again).toBe(false);
      expect(decision.settledTicks).toBe(1);
    }
  });

  it('settles after two consecutive small deltas', () => {
    const small = CLOSE_LOOP_SETTLE_DELTA_POINTS / 2;

    const first = decideTick(tickInput({ percent: 40 + small, previousPercent: 40 }));
    expect(first.state).toBe('RUNNING');
    expect(first.settledTicks).toBe(1);

    const second = decideTick(
      tickInput({ percent: 40 + small, previousPercent: 40, settledTicks: first.settledTicks }),
    );
    expect(second.settledTicks).toBe(CLOSE_LOOP_SETTLE_TICKS);
    expect(second.state).toBe('SETTLED');
    expect(second.again).toBe(false);
  });

  it('counts a delta in EITHER direction as movement', () => {
    // Coverage going down is movement, not settlement. A rule that only
    // noticed improvement would tick through a regression it was causing.
    const decision = decideTick(tickInput({ percent: 30, previousPercent: 40, settledTicks: 1 }));
    expect(decision.state).toBe('RUNNING');
    expect(decision.settledTicks).toBe(0);
    expect(decision.deltaPoints).toBe(10);
  });

  it('refuses to settle while items are still awaiting generation', () => {
    /*
     * The subtle one. A tick taken while the Generator is still working has a
     * legitimately zero delta, so a settle rule that ignored this would stop
     * almost every campaign immediately after its first proposal — the loop
     * halting BECAUSE its work had not landed yet.
     */
    const decision = decideTick(
      tickInput({ percent: 40, previousPercent: 40, settledTicks: 1, pendingGeneration: 3 }),
    );
    expect(decision.state).toBe('RUNNING');
    expect(decision.settledTicks).toBe(1);
  });

  it('stops when the nightly budget is spent', () => {
    const decision = decideTick(tickInput({ itemsProposed: 40, nightlyItemBudget: 40 }));
    expect(decision.state).toBe('BUDGET_SPENT');
    expect(decision.again).toBe(false);
  });

  it('stops when nothing is proposable, naming the ledger', () => {
    const decision = decideTick(tickInput({ selectable: 0 }));
    expect(decision.state).toBe('NOTHING_LEFT');
    expect(decision.again).toBe(false);
    expect(decision.reason).toContain('ledger');
  });

  it('spends one tick and then stops when nothing can generate', () => {
    /*
     * The only branch that is terminal AND keeps a budget. A missing model key
     * is a MISSING TOOL: the gaps, the ranking and the steps read off the crawl
     * are exactly as good without one, so the tick writes an approvable plan.
     * A SECOND tick would re-measure a number that cannot have moved, which is
     * the spin — so `again` is false and `itemBudget` is not.
     */
    const decision = decideTick(tickInput({ generatorAvailable: false, topK: 4 }));
    expect(decision.state).toBe('BLOCKED');
    expect(decision.again).toBe(false);
    expect(decision.itemBudget).toBe(4);
    expect(decision.reason).toContain('written from the crawl');
  });

  it('runs, and never asks for more than the budget allows', () => {
    const decision = decideTick(
      tickInput({ topK: 8, nightlyItemBudget: 10, itemsProposed: 7, selectable: 50 }),
    );
    expect(decision.state).toBe('RUNNING');
    expect(decision.again).toBe(true);
    // 10 - 7, not 8: the night's cap beats the tick's cap.
    expect(decision.itemBudget).toBe(3);
  });

  it('never asks for more items than there are gaps to propose', () => {
    expect(decideTick(tickInput({ selectable: 2, topK: 8 })).itemBudget).toBe(2);
  });
});

describe('the campaign tunables', () => {
  it('keys the nightly budget on the UTC day', () => {
    expect(dayKeyOf(new Date('2026-10-24T23:59:00.000Z'))).toBe('2026-10-24');
    expect(dayKeyOf(new Date('2026-10-25T00:01:00.000Z'))).toBe('2026-10-25');
  });

  it('falls back to human review for anything it does not recognise', () => {
    expect(approvalPolicyOf('AUTO_APPROVE')).toBe('AUTO_APPROVE');
    expect(approvalPolicyOf('HUMAN_REVIEW')).toBe('HUMAN_REVIEW');
    // A typo in a project column must not switch unattended generation ON.
    expect(approvalPolicyOf('auto')).toBe('HUMAN_REVIEW');
    expect(approvalPolicyOf(null)).toBe('HUMAN_REVIEW');
  });
});

// ─── One tick ────────────────────────────────────────────────────────────────

describe('a tick that spends budget', () => {
  it('writes the gap id onto every plan item and opens a ledger row', async () => {
    const { recompute } = stubRecompute([40]);

    /*
     * AUTO_APPROVE, and not because this test is about the policy — it is about
     * provenance. It needs a campaign that actually reaches the enqueue, and
     * the fixture's default is HUMAN_REVIEW, which no longer does. This test
     * used to run on that default and assert the generation was queued anyway,
     * which is the defect it was unknowingly pinning in place.
     */
    const outcome = await processCloseLoopTick(campaign({ approvalPolicy: 'AUTO_APPROVE' }), {
      recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.itemsProposed).toBe(2);
    expect(store.planItems).toHaveLength(2);

    /*
     * THE DEFECT, AS AN ASSERTION. The mapping used to exist only in an HTTP
     * response. Without `gapId` on the row, nothing afterwards can say which
     * test was supposed to close which gap — or notice that it did not.
     */
    expect(store.planItems.map((item) => item.gapId).sort()).toEqual(['gap_a', 'gap_b']);
    expect(store.planItems.every((item) => item.gapKind === 'UNVISITED_ROUTE')).toBe(true);

    expect(store.closures).toHaveLength(2);
    expect(store.closures[0]).toMatchObject({
      projectId: 'proj_1',
      gapId: 'gap_a',
      state: 'PROPOSED',
      campaignId: 'camp_1',
    });
    // The ledger row points at the SAME row id the plan item was given, which
    // is only true because the ids are minted before the write.
    expect(store.closures.map((c) => c.planItemId).sort()).toEqual(
      store.planItems.map((i) => i.id).sort(),
    );

    expect(h.generates).toHaveLength(1);
    expect(h.generates[0]).toMatchObject({
      orgId: 'org_1',
      projectId: 'proj_1',
      planItemIds: store.planItems.map((i) => i.id),
    });
  });

  it('honours the approval policy, which is the only thing that decides whether code is written unattended', async () => {
    const { recompute } = stubRecompute([40]);

    await processCloseLoopTick(campaign({ approvalPolicy: 'HUMAN_REVIEW' }), {
      recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(store.planItems.every((item) => item.state === 'PROPOSED')).toBe(true);
    expect(store.planItems.every((item) => item.decidedAt === undefined)).toBe(true);

    store.planItems = [];
    store.closures = [];
    await processCloseLoopTick(campaign({ approvalPolicy: 'AUTO_APPROVE' }), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(store.planItems.every((item) => item.state === 'APPROVED')).toBe(true);
    expect(store.planItems[0]!.decidedBy).toBe('close-loop:camp_1');
  });

  /*
   * THE BRAKE, AS AN ASSERTION, and the state of the plan item is not it.
   *
   * The items landing PROPOSED was already true and already tested, above —
   * and it was not a brake. `propose` enqueued generation for every item id
   * regardless of the policy, and processors/generate.ts selects its items by
   * id with no state filter, so the documented default wrote PROPOSED items
   * onto the approval screen and then had a model write the code for them
   * anyway. The only assertion that can tell those two worlds apart is one
   * about the QUEUE, which is why it is here and not folded into the test
   * above it.
   */
  it('queues no generation at all for items a human has not approved', async () => {
    const outcome = await processCloseLoopTick(campaign({ approvalPolicy: 'HUMAN_REVIEW' }), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      // A key IS present. Nothing here is excused by a missing tool — the
      // deployment can generate, and is not asked to.
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(h.generates).toEqual([]);
    expect(outcome.generationQueued).toBe(false);

    // And the deterministic half is still done, because that is what the
    // approval screen is for. A brake that threw the plan away would be a
    // different defect.
    expect(outcome.itemsProposed).toBe(2);
    expect(store.planItems).toHaveLength(2);
    expect(store.closures).toHaveLength(2);
  });

  it('queues generation once the policy says a human already decided', async () => {
    const outcome = await processCloseLoopTick(campaign({ approvalPolicy: 'AUTO_APPROVE' }), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.generationQueued).toBe(true);
    expect(h.generates).toHaveLength(1);
    // The items it names are APPROVED ones, which is the invariant
    // processors/explore.ts and POST /coverage/:projectId/propose both hold:
    // generation follows approval everywhere, or it follows it nowhere.
    const queued = h.generates[0]!.planItemIds as string[];
    expect(queued.sort()).toEqual(store.planItems.map((i) => i.id).sort());
    expect(store.planItems.every((item) => item.state === 'APPROVED')).toBe(true);
  });

  it('schedules the next tick, and only while it is still running', async () => {
    const campaignRow = { id: 'camp_1', state: 'RUNNING', projectId: 'proj_1', dayKey: '2026-10-24' };
    store.campaigns.push(campaignRow);

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(campaignRow).toMatchObject({ state: 'RUNNING', tick: 1, lastPercent: 40 });
    expect((campaignRow as Row).nextTickAt).toEqual(new Date(NOW.getTime() + CLOSE_LOOP_TICK_MS));
    expect((campaignRow as Row).stoppedReason).toBeNull();
  });

  it('keeps the deterministic work and stops when nothing can generate', async () => {
    const campaignRow = { id: 'camp_1', state: 'RUNNING', projectId: 'proj_1' };
    store.campaigns.push(campaignRow);

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      // No key on this deployment. A MISSING TOOL, not a failure.
      generatorAvailable: false,
      now: () => NOW,
    });

    // The plan and the ledger rows were written from the crawl and are already
    // worth having, so they are kept.
    expect(outcome.itemsProposed).toBe(2);
    expect(store.planItems).toHaveLength(2);
    expect(outcome.generationQueued).toBe(false);
    expect(h.generates).toEqual([]);

    // And the loop stops rather than re-measuring a number nothing can move.
    expect(outcome.state).toBe('BLOCKED');
    expect(outcome.again).toBe(false);
    expect((campaignRow as Row).nextTickAt).toBeNull();
    expect((campaignRow as Row).finishedAt).toEqual(NOW);
  });

  it('records a null percent as null, and refuses to tick again', async () => {
    const campaignRow = { id: 'camp_1', state: 'RUNNING', projectId: 'proj_1' };
    store.campaigns.push(campaignRow);

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([null]).recompute,
      gapReport: stubGapReport({ crawled: false, gaps: [] }),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.percent).toBeNull();
    expect(outcome.state).toBe('UNMEASURABLE');
    // Never 0. A stored 0 would read as "nothing in your app is covered".
    expect((campaignRow as Row).lastPercent).toBeNull();
    expect((campaignRow as Row).lastDeltaPoints).toBeNull();
    expect((campaignRow as Row).nextTickAt).toBeNull();
    // Nothing was proposed against an application we cannot see.
    expect(store.planItems).toEqual([]);
  });

  it('does not propose a gap the ledger already has in flight', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'TEST_WRITTEN',
      planItemId: 'item_old',
      testId: 'test_old',
      reopenCount: 0,
    });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // gap_a is still reported, so it is NOT_CLOSED and must not be retried.
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.notClosed).toBe(1);
    expect(store.planItems.map((item) => item.gapId)).toEqual(['gap_b']);
  });
});

// ─── Provenance and closure, as the processor performs them ─────────────────

describe('provenance is stamped before closure is judged', () => {
  it('copies the gap id onto the generated test and moves the ledger to TEST_WRITTEN', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'PROPOSED',
      planItemId: 'item_1',
      testId: null,
      reopenCount: 0,
    });
    store.planItems.push({ id: 'item_1', gapId: 'gap_a', generatedTestId: 'test_1' });
    store.tests.push({ id: 'test_1', orgId: 'org_1', gapId: null });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // gap_a is gone from a COMPLETE report, so it closed.
      gapReport: stubGapReport({ gaps: [gap({ id: 'gap_b', score: 80 })] }),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.testsLinked).toBe(1);
    expect(store.tests[0]!.gapId).toBe('gap_a');

    /*
     * The ORDER is what this proves. Provenance is stamped first, so closure is
     * judged with `testId` set and the row can name the test that closed the
     * gap. Reversed, the gap would be judged with `testId: null` and recorded
     * as "closed, no test of ours responsible" — the ledger forgetting the work
     * it had itself commissioned.
     */
    const closure = store.closures[0]!;
    expect(closure.state).toBe('CLOSED');
    expect(closure.testId).toBe('test_1');
    expect(closure.why).toContain('test_1');
    expect(closure.closedAt).toEqual(NOW);
  });

  it('never relabels a test that already names its gap', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'PROPOSED',
      planItemId: 'item_1',
      testId: null,
      reopenCount: 0,
    });
    store.planItems.push({ id: 'item_1', gapId: 'gap_a', generatedTestId: 'test_1' });
    store.tests.push({ id: 'test_1', orgId: 'org_1', gapId: 'gap_original' });

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport({ gaps: [] }),
      generatorAvailable: true,
      now: () => NOW,
    });

    // First-writer-wins: the test keeps the gap it was actually written for.
    expect(store.tests[0]!.gapId).toBe('gap_original');
  });

  it('counts a re-opened gap and keeps the count across closures', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'CLOSED',
      planItemId: 'item_1',
      testId: 'test_1',
      reopenCount: 1,
    });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.reopened).toBe(1);
    expect(store.closures[0]).toMatchObject({ state: 'REOPENED', reopenCount: 2 });
    expect(store.closures[0]!.reopenedAt).toEqual(NOW);
  });

  it('calls closure unverifiable rather than claiming it, when the report is a page', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_missing',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'TEST_WRITTEN',
      planItemId: 'item_1',
      testId: 'test_1',
      reopenCount: 0,
    });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // The gap is absent, but the report was TRUNCATED — so its absence is
      // evidence of nothing at all.
      gapReport: stubGapReport({ complete: false }),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.unverifiable).toBe(1);
    expect(outcome.closed).toBe(0);
    expect(store.closures[0]!.state).toBe('UNVERIFIABLE');
    expect(store.closures[0]!.closedAt).toBeUndefined();
  });

  it('treats a state it does not recognise as OPEN, loudly', async () => {
    /*
     * `GapClosure.state` is a TEXT column, so the database accepts anything —
     * a value from a newer deploy, or a hand-written UPDATE in psql. Casting it
     * would hand `verifyClosure` a state its rule has never heard of; reading
     * it back through the domain falls to OPEN, which is the conservative
     * direction (it can only ever under-claim closure, never over-claim it).
     */
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'MOSTLY_CLOSED',
      planItemId: null,
      testId: null,
      reopenCount: 0,
      lastCheckedAt: null,
    });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // gap_a is gone from a COMPLETE report, so the rule gets to run.
      gapReport: stubGapReport({ gaps: [] }),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(
      h.log.some((entry) => entry.msg.includes('state this build does not recognise')),
    ).toBe(true);
    // Reconciled rather than skipped or thrown on: the row keeps moving.
    expect(store.closures[0]!.lastCheckedAt).toEqual(NOW);
    expect(store.closures[0]!.state).toBe('CLOSED');
    expect(outcome.state).toBe('NOTHING_LEFT');
  });

  it('stamps lastCheckedAt even on a row whose state did not change', async () => {
    store.closures.push({
      id: 'clo_1',
      orgId: 'org_1',
      projectId: 'proj_1',
      gapId: 'gap_a',
      gapKind: 'UNVISITED_ROUTE',
      gapTitle: 'x',
      state: 'PROPOSED',
      planItemId: 'item_1',
      testId: null,
      reopenCount: 0,
      lastCheckedAt: null,
    });
    store.planItems.push({ id: 'item_1', gapId: 'gap_a', generatedTestId: null });

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // A row nothing has re-measured for a week is not a row whose state is
    // current, and a reader has to be able to tell the difference.
    expect(store.closures[0]!.lastCheckedAt).toEqual(NOW);
    expect(store.closures[0]!.state).toBe('PROPOSED');
  });

  /*
   * THE WORK PER CAMPAIGN, COUNTED.
   *
   * CLOSE_LOOP_SWEEP_LIMIT bounds campaigns per tick and nothing bounded the
   * work inside one. `reconcileLedger` awaited one UPDATE per ledger row, in
   * series, and a project carries one row per gap it has ever had proposed —
   * so twenty campaigns of three hundred gaps was six thousand sequential
   * round trips inside the 60-second tick shared with the cron schedules and
   * the monitors.
   *
   * No assertion about row VALUES can see that: the values were right. So this
   * counts statements, and it is the only test in the file that does.
   */
  it('confirms a hundred unchanged ledger rows in ONE statement, not a hundred', async () => {
    // Already CLOSED, and absent from a report that is `complete` — so
    // `verifyClosure` returns CLOSED for every one of them and NOTHING
    // changes. The unchanged path is the one that used to be a hundred
    // sequential UPDATEs of a single column.
    for (let i = 0; i < 100; i += 1) {
      store.closures.push({
        id: `clo_${i}`,
        orgId: 'org_1',
        projectId: 'proj_1',
        gapId: `old_${i}`,
        gapKind: 'UNVISITED_ROUTE',
        gapTitle: 'x',
        state: 'CLOSED',
        planItemId: null,
        testId: null,
        reopenCount: 0,
        lastCheckedAt: null,
      });
    }

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // The hundred stale gaps are absent from this report and already CLOSED,
      // so `verifyClosure` returns CLOSED unchanged for every one of them.
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // The whole point: ONE statement for the hundred confirmations.
    expect(store.writes.closureUpdateMany).toBe(1);
    expect(store.writes.closureUpdate).toBe(0);

    /*
     * And they were genuinely written — a batch that collected the ids and
     * never issued the statement would leave `lastCheckedAt` null and make the
     * two counts above pass for the wrong reason.
     *
     * Scoped to the hundred seeded rows: this tick also PROPOSES the two gaps
     * the report holds, so the ledger ends with 102 rows and the two new ones
     * are PROPOSED by design.
     */
    const confirmed = store.closures.filter((row) => (row.gapId as string).startsWith('old_'));
    expect(confirmed).toHaveLength(100);
    expect(confirmed.every((row) => row.lastCheckedAt === NOW)).toBe(true);
    expect(confirmed.every((row) => row.state === 'CLOSED')).toBe(true);
  });

  it('writes a changed row per statement, but in bounded batches', async () => {
    // Recorded CLOSED and reported again: REOPENED, so every row changes and
    // every `why` names its own row. These cannot be one statement, and the
    // bound is the batch size rather than the row count.
    const gaps = Array.from({ length: 3 }, (_, i) => gap({ id: `gap_r${i}` }));
    for (let i = 0; i < 3; i += 1) {
      store.closures.push({
        id: `clo_r${i}`,
        orgId: 'org_1',
        projectId: 'proj_1',
        gapId: `gap_r${i}`,
        gapKind: 'UNVISITED_ROUTE',
        gapTitle: 'x',
        state: 'CLOSED',
        planItemId: null,
        testId: `test_${i}`,
        reopenCount: 0,
        lastCheckedAt: null,
      });
    }

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport({ gaps }),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.reopened).toBe(3);
    // Three statements, because three distinct `why` strings — and NO
    // `updateMany`, because nothing was unchanged. Both halves matter: a
    // version that folded changed rows into one `updateMany` would lose every
    // row's own sentence.
    expect(store.writes.closureUpdate).toBe(3);
    expect(store.writes.closureUpdateMany).toBe(0);
    expect(store.closures.every((row) => row.state === 'REOPENED')).toBe(true);
    expect(store.closures.every((row) => row.reopenCount === 1)).toBe(true);
    // Each row's sentence names ITS OWN test, which is what the per-row
    // statement buys.
    expect(store.closures.map((row) => row.why as string).some((why) => why.includes('test_1')));
    expect(new Set(store.closures.map((row) => row.why)).size).toBe(3);
  });
});

// ─── The number's provenance ─────────────────────────────────────────────────

describe('a published delta names the stored row behind each of its operands', () => {
  /*
   * `ClosureCampaign.lastSnapshotId` was written by this tick and read by
   * nothing, while its schema comment claimed the campaign's number was
   * traceable through it. It is now the delta's BASELINE provenance: the
   * snapshot the earlier operand came out of.
   */
  it('reports both operands and both snapshots, and no baseline on a first tick', async () => {
    const first = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // A first measurement is not a movement of zero, and it has no baseline to
    // be traceable to. Null, both of them — never 0 and never a guess.
    expect(first.deltaPoints).toBeNull();
    expect(first.baselinePercent).toBeNull();
    expect(first.baselineSnapshotId).toBeNull();
    expect(first.snapshotId).toBe('snap_1');

    const second = await processCloseLoopTick(
      campaign({ tick: 1, lastPercent: 40, lastSnapshotId: 'snap_1' }),
      {
        recompute: stubRecompute([42]).recompute,
        gapReport: stubGapReport(),
        generatorAvailable: true,
        now: () => NOW,
      },
    );

    expect(second.deltaPoints).toBe(2);
    expect(second.baselinePercent).toBe(40);
    // The whole fix: the 40 the movement was measured against is traceable to
    // a row, not just the 42 it was measured to.
    expect(second.baselineSnapshotId).toBe('snap_1');
  });

  it('says so when the baseline it is comparing against was never stored', async () => {
    // Reachable whenever the measurement behind `lastPercent` was computed and
    // not persisted. A baseline percent with no row behind it is worth knowing
    // before quoting the movement, so it is reported rather than smoothed to
    // look like the traceable case.
    const outcome = await processCloseLoopTick(
      campaign({ tick: 1, lastPercent: 40, lastSnapshotId: null }),
      {
        recompute: stubRecompute([42]).recompute,
        gapReport: stubGapReport(),
        generatorAvailable: true,
        now: () => NOW,
      },
    );

    expect(outcome.deltaPoints).toBe(2);
    expect(outcome.baselinePercent).toBe(40);
    expect(outcome.baselineSnapshotId).toBeNull();
  });
});

// ─── The re-crawl ────────────────────────────────────────────────────────────

describe('the re-crawl is bounded twice over', () => {
  const stale = () =>
    stubGapReport({
      flowMapCreatedAt: new Date(NOW.getTime() - CLOSE_LOOP_RECRAWL_AFTER_MS - 1000),
    });

  it('asks for one crawl when the newest one is stale', async () => {
    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stale(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(outcome.recrawlQueued).toBe(true);
    expect(h.explores).toHaveLength(1);
    expect(h.explores[0]).toMatchObject({
      projectId: 'proj_1',
      // The environment the EXISTING crawl came from. Guessing one would point
      // an unattended browser at whichever environment happened to be first.
      environmentId: 'env_1',
      // Never. The crawl's own plan would bypass this campaign's budget and its
      // approval policy entirely.
      autoApprove: false,
      /*
       * THE BOUNDS, which nothing used to assert: both survived being deleted.
       * "Modest: this is unattended" is the whole justification for the loop
       * being allowed to hold a browser at all, and an unbounded crawl queued
       * at 03:00 is the version of this feature that gets it switched off.
       */
      maxPages: CLOSE_LOOP_RECRAWL_MAX_PAGES,
      maxDepth: CLOSE_LOOP_RECRAWL_MAX_DEPTH,
    });
  });

  /*
   * THE PRIMARY BOUND, and it was the untested one.
   *
   * `recrawlQueuedAt` on the row is what makes the re-crawl once per campaign —
   * and, through the unique day key, once per project per day. `maybeRecrawl`
   * READING it was tested ("never crawls twice in one campaign"); the tick
   * WRITING it was not, so deleting the write left every tick free to queue
   * another crawl and the suite stayed green. One browser per fifteen minutes
   * until morning, which is the exact failure the constant's comment describes.
   */
  it('records that it crawled, which is what stops the next tick crawling again', async () => {
    const row = { id: 'camp_1', state: 'RUNNING', projectId: 'proj_1', dayKey: '2026-10-24' };
    store.campaigns.push(row);

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stale(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect((row as Row).recrawlQueuedAt).toEqual(NOW);

    // And the next tick, handed the row it just wrote, does not crawl again.
    h.explores = [];
    const second = await processCloseLoopTick(
      campaign({ tick: 1, recrawlQueuedAt: (row as Row).recrawlQueuedAt as Date }),
      {
        recompute: stubRecompute([40]).recompute,
        gapReport: stale(),
        generatorAvailable: true,
        now: () => NOW,
      },
    );
    expect(second.recrawlQueued).toBe(false);
    expect(h.explores).toEqual([]);
  });

  it('does not stamp recrawlQueuedAt on a tick that did not crawl', async () => {
    // The other half of the same write: a tick that queued nothing must not
    // claim the campaign's one crawl and spend it.
    const row = { id: 'camp_1', state: 'RUNNING', projectId: 'proj_1', dayKey: '2026-10-24' };
    store.campaigns.push(row);

    await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      // Crawled this morning: not stale, so no crawl is queued.
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect((row as Row).recrawlQueuedAt).toBeUndefined();
  });

  it('leaves a project crawled this morning alone', async () => {
    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(outcome.recrawlQueued).toBe(false);
    expect(h.explores).toEqual([]);
  });

  it('never crawls twice in one campaign', async () => {
    const outcome = await processCloseLoopTick(campaign({ recrawlQueuedAt: NOW }), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stale(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(outcome.recrawlQueued).toBe(false);
    expect(h.explores).toEqual([]);
  });

  it('does not crawl a project with no existing crawl to aim at', async () => {
    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport({ environmentId: null, flowMapCreatedAt: null }),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(outcome.recrawlQueued).toBe(false);
  });

  it('does not lose a tick to a crawl that could not be queued', async () => {
    h.exploreThrows = new Error('redis is gone');
    store.campaigns.push({ id: 'camp_1', state: 'RUNNING', projectId: 'proj_1' });

    const outcome = await processCloseLoopTick(campaign(), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stale(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // The measurement, the ledger and the proposals are all already done and
    // stored. Throwing here would discard a tick's real work over an optional
    // refresh.
    expect(outcome.recrawlQueued).toBe(false);
    expect(outcome.itemsProposed).toBe(2);
    expect(h.log.some((entry) => entry.level === 'warn')).toBe(true);
  });
});

// ─── The sweep ───────────────────────────────────────────────────────────────

describe('advanceClosureCampaigns', () => {
  const project = (over: Row = {}) => ({
    id: 'proj_1',
    orgId: 'org_1',
    archivedAt: null,
    coverageTargetPercent: 80,
    closureApprovalPolicy: null,
    closureItemBudget: null,
    ...over,
  });

  it('arms nothing for a project that never asked', async () => {
    store.projects.push(project({ coverageTargetPercent: null }));
    const sweep = await advanceClosureCampaigns(NOW);
    expect(sweep.armed).toBe(0);
    expect(store.campaigns).toEqual([]);
  });

  it('arms nothing for an archived project', async () => {
    store.projects.push(project({ archivedAt: new Date() }));
    expect((await advanceClosureCampaigns(NOW)).armed).toBe(0);
  });

  it('arms one campaign, due immediately, with the project brakes applied', async () => {
    store.projects.push(
      project({ coverageTargetPercent: 140, closureItemBudget: 3, closureApprovalPolicy: 'AUTO_APPROVE' }),
    );

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.armed).toBe(1);
    expect(store.campaigns[0]).toMatchObject({
      projectId: 'proj_1',
      dayKey: '2026-10-24',
      state: 'RUNNING',
      // Clamped: a target of 140 is a campaign that can never meet its target
      // and would tick to the ceiling every night.
      targetPercent: 100,
      nightlyItemBudget: 3,
      approvalPolicy: 'AUTO_APPROVE',
    });
    // Armed AND advanced in the same sweep, because it is due immediately.
    expect(sweep.advanced).toBe(1);
  });

  it('arms at most one campaign per project per UTC day', async () => {
    store.projects.push(project());
    await advanceClosureCampaigns(NOW, {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    const after = store.campaigns.length;

    // A second sweep in the same night. THIS is the nightly budget: without the
    // constraint, a 60-second sweep would arm 1,440 campaigns a day.
    const second = await advanceClosureCampaigns(new Date(NOW.getTime() + 60_000), {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });
    expect(second.armed).toBe(0);
    expect(store.campaigns).toHaveLength(after);
  });

  it('treats a collision with another worker as a skip, not an error', async () => {
    /*
     * MUTATION-FOUND GAP. The one-campaign-per-day test passes even with the
     * `closureCampaigns: { none: { dayKey } }` pre-filter removed, because the
     * UNIQUE INDEX is the real enforcement and the filter only keeps the insert
     * small. So the thing worth proving is what happens when the pre-filter
     * cannot help: two workers sweeping in the same second both read "nothing
     * armed today" and both insert. Modelled by a project query that ignores
     * the filter — which is exactly the window between the read and the write.
     *
     * `skipDuplicates: true` is what makes the loser a no-op instead of a
     * logged error, and without it an install with two workers would write an
     * error to the log every single night.
     */
    store.projects.push(project());
    store.campaigns.push({ ...campaign(), state: 'SETTLED', nextTickAt: null });

    const db = makeDb();
    h.prisma = {
      ...db,
      project: { findMany: async () => store.projects.map((row) => ({ ...row })) },
    };

    const sweep = await advanceClosureCampaigns(NOW, { now: () => NOW });

    expect(sweep.armed).toBe(0);
    expect(store.campaigns).toHaveLength(1);
    // Not an error: a collision is the constraint doing its job.
    expect(h.log.some((entry) => entry.level === 'error')).toBe(false);
  });

  it('claims a due tick before running it, so two workers cannot both spend the budget', async () => {
    store.campaigns.push({
      ...campaign(),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    });

    let seenAtTickTime: Date | null = null;
    await advanceClosureCampaigns(NOW, {
      recompute: async (job) => {
        // Read inside the tick: the claim has already moved the clock forward.
        seenAtTickTime = store.campaigns[0]!.nextTickAt as Date;
        return stubRecompute([40]).recompute(job);
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(seenAtTickTime).toEqual(new Date(NOW.getTime() + CLOSE_LOOP_TICK_MS));
  });

  /*
   * THE CAP ON CAMPAIGNS PER SWEEP, DISCLOSED.
   *
   * The cap is right — this is a guest in the 60-second tick — but
   * `{ armed: 20, advanced: 20 }` read identically whether twenty campaigns
   * were due or two thousand, and a cap applied without being disclosed is the
   * lie this product cannot afford. Nothing is dropped from the QUEUE, only
   * from this tick.
   */
  it('says when more campaigns were due than one sweep may advance', async () => {
    for (let i = 0; i < CLOSE_LOOP_SWEEP_LIMIT + 1; i += 1) {
      store.campaigns.push({
        ...campaign({ id: `camp_${i}`, projectId: `proj_${i}` }),
        state: 'RUNNING',
        nextTickAt: new Date(NOW.getTime() - 1000),
      });
    }

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.moreDue).toBe(true);
    // The limit is still APPLIED — disclosure is not permission to ignore it.
    expect(sweep.advanced).toBe(CLOSE_LOOP_SWEEP_LIMIT);
    expect(
      h.log.some(
        (entry) => entry.level === 'warn' && entry.msg.includes('more closure campaigns are due'),
      ),
    ).toBe(true);
  });

  it('claims nothing extra when the due campaigns fit', async () => {
    // The other half, so the flag is a fact rather than a permanent warning:
    // exactly at the limit is NOT truncated.
    for (let i = 0; i < CLOSE_LOOP_SWEEP_LIMIT; i += 1) {
      store.campaigns.push({
        ...campaign({ id: `camp_${i}`, projectId: `proj_${i}` }),
        state: 'RUNNING',
        nextTickAt: new Date(NOW.getTime() - 1000),
      });
    }

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.moreDue).toBe(false);
    expect(sweep.advanced).toBe(CLOSE_LOOP_SWEEP_LIMIT);
  });

  it('leaves a campaign that is not due alone', async () => {
    store.campaigns.push({
      ...campaign(),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() + 60_000),
    });
    const sweep = await advanceClosureCampaigns(NOW, { now: () => NOW });
    expect(sweep.advanced).toBe(0);
  });

  it('leaves a campaign that has stopped alone, for ever', async () => {
    // `nextTickAt: null` on a terminal campaign is what makes the stop
    // structural rather than a decision something has to keep making.
    store.campaigns.push({ ...campaign(), state: 'SETTLED', nextTickAt: null });
    const sweep = await advanceClosureCampaigns(NOW, { now: () => NOW });
    expect(sweep.advanced).toBe(0);
  });

  it('records a failing tick on the row and never throws', async () => {
    store.campaigns.push({
      ...campaign(),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    });

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('the database went away');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.failed).toBe(1);
    /*
     * NEVER THROWS is the contract: this runs inside the scheduler tick beside
     * the cron schedules and the production monitors, and a throw here would
     * take a customer's nightly suite and their uptime check down with it.
     */
    expect(store.campaigns[0]!.stoppedReason).toContain('the database went away');
    expect(store.campaigns[0]!.state).toBe('RUNNING');

    /*
     * AND IT IS COUNTED. `tick` used to be incremented in exactly one place —
     * the successful tick's own update — so a failing tick was recorded and
     * never counted, and the hard ceiling could not see it.
     */
    expect(store.campaigns[0]!.tick).toBe(1);
    // Nothing was measured, so nothing claims to have been. This is the
    // null-that-must-not-become-0 on the failure path.
    expect(store.campaigns[0]!.lastPercent).toBeNull();
    expect(store.campaigns[0]!.stoppedReason).toContain('Nothing was measured');
  });

  /*
   * ── THE OTHER DIRECTION OF THE SAME RULE ──────────────────────────────────
   *
   * The test above seeds `lastPercent: null` from the fixture, so `toBeNull()`
   * passes whether the failure path LEFT the column alone or WIPED it. It
   * catches a failed tick writing 0 and cannot catch one writing null, and
   * those are the two opposite lies about one column: 0 says "nothing in your
   * app is covered", null says "we cannot see your app", and a failed tick is
   * entitled to say neither about a project it measured at 62% fifteen minutes
   * ago.
   *
   * This matters because of what the sentence promises. `recordFailedTick`
   * writes "any percentage on this row is from the last tick that completed
   * rather than from <now>" — a sentence that is only true if that percentage
   * is STILL THERE. Wiping it leaves the row claiming provenance for a number
   * it no longer holds, and turns a measured project into an unmeasured one on
   * the strength of one Redis hiccup.
   *
   * `lastSnapshotId` goes with it: it is the provenance of the surviving
   * number, and a percentage whose snapshot row has been nulled is exactly the
   * half-traceable state `CampaignRow` says must be reported rather than
   * produced.
   */
  it('leaves the last completed tick\'s measurement and its provenance alone', async () => {
    const row: Row = {
      ...campaign({ tick: 2, lastPercent: 62, lastSnapshotId: 'snap_real' }),
      state: 'RUNNING',
      previousPercent: 58,
      lastDeltaPoints: 4,
      nextTickAt: new Date(NOW.getTime() - 1000),
    };
    store.campaigns.push(row);

    await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('redis hiccup');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // Counted, and the clock moved.
    expect(row.tick).toBe(3);
    expect(row.lastTickAt).toEqual(NOW);

    // The measurement did NOT. Neither operand, neither delta, and the
    // snapshot row behind the later operand is still named.
    expect(row.lastPercent).toBe(62);
    expect(row.lastSnapshotId).toBe('snap_real');
    expect(row.previousPercent).toBe(58);
    expect(row.lastDeltaPoints).toBe(4);

    // And the sentence is what makes the stale pair readable rather than a
    // trap: it says the numbers are older than the timestamp above them.
    expect(row.stoppedReason).toContain('Nothing was measured');
    expect(row.stoppedReason).toContain('the last tick that completed');
  });

  /*
   * THE CEILING, ON THE PATH THAT COULD NOT REACH IT.
   *
   * Proven before the fix: 41 failing ticks against a ceiling of 24, still
   * RUNNING, still at tick 0 — swept again every sixty seconds, with its own
   * claim pushing `nextTickAt` forward each time. And it does not age out:
   * `armCampaigns` only ever inserts for TODAY, while the sweep reads every
   * RUNNING campaign whose tick is due whatever its `dayKey`, so one stuck row
   * accumulates per project per UTC day and keeps its place in the sweep's
   * twenty for ever. A campaign that cannot end is a campaign that spends for
   * ever.
   */
  it('ends a campaign whose ticks keep failing, at the same ceiling a working one has', async () => {
    const row: Row = {
      ...campaign({ tick: CLOSE_LOOP_MAX_TICKS }),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    };
    store.campaigns.push(row);

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('the database went away');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.failed).toBe(1);
    expect(row.tick).toBe(CLOSE_LOOP_MAX_TICKS + 1);
    expect(row.state).toBe('TICK_CEILING');
    /*
     * `nextTickAt: null` is what actually stops it: the sweep reads exactly
     * that column, so this is the campaign being made structurally unable to
     * tick again rather than merely labelled.
     */
    expect(row.nextTickAt).toBeNull();
    expect(row.finishedAt).toEqual(NOW);
    // The sentence may say it stopped and why, and may NOT say it measured
    // anything: the percentage columns beside it are from an earlier tick.
    expect(row.stoppedReason).toContain('hard ceiling');
    expect(row.stoppedReason).toContain('the database went away');
    expect(row.stoppedReason).toContain('Nothing was measured');
    expect(row.lastPercent).toBeNull();
  });

  it('is the same ceiling on both paths, which is why there is one function for it', () => {
    // A ceiling a campaign can cross on one path and not the other is a
    // campaign that cannot end, so the two callers must agree exactly.
    expect(pastTickCeiling(CLOSE_LOOP_MAX_TICKS)).toBe(false);
    expect(pastTickCeiling(CLOSE_LOOP_MAX_TICKS + 1)).toBe(true);
    // The tick that RAN, deciding the same thing with the same input.
    expect(decideTick(tickInput({ tick: CLOSE_LOOP_MAX_TICKS })).state).not.toBe('TICK_CEILING');
    expect(decideTick(tickInput({ tick: CLOSE_LOOP_MAX_TICKS + 1 })).state).toBe('TICK_CEILING');
  });

  /*
   * ── AND THEY SAY THE SAME NUMBER ABOUT IT ─────────────────────────────────
   *
   * The comparison being shared was tested above; the SENTENCE was not tested
   * at all, and it was wrong. `decideTick` said "has taken ${CLOSE_LOOP_MAX_
   * TICKS} ticks" — always 24 — on a branch that only fires at 25, and
   * `processCloseLoopTick` writes that 25 to `ClosureCampaign.tick` in the same
   * statement that writes this sentence to `stoppedReason`. So the row read
   * `tick: 25` beside "has taken 24 ticks", on the one column the schema
   * documents as "meant to be shown verbatim", while `recordFailedTick`'s
   * sentence for the identical event named the true number.
   *
   * Asserted as "the tick the row will hold", not as a literal, so this cannot
   * be satisfied by a second hard-coded number drifting the other way.
   */
  it('names the tick it actually recorded, on both paths, not the ceiling constant', async () => {
    const recorded = CLOSE_LOOP_MAX_TICKS + 1;

    const ran = decideTick(tickInput({ tick: recorded }));
    expect(ran.state).toBe('TICK_CEILING');
    expect(ran.reason).toContain(`has taken ${recorded} ticks`);
    expect(ran.reason).toContain(`hard ceiling of ${CLOSE_LOOP_MAX_TICKS}`);
    // The bug, stated as the thing that must not come back: the sentence may
    // not claim the ceiling's value as the count of ticks taken.
    expect(ran.reason).not.toContain(`has taken ${CLOSE_LOOP_MAX_TICKS} ticks`);

    // The tick that THREW, at the same ceiling, writing the same number.
    const row: Row = {
      ...campaign({ tick: CLOSE_LOOP_MAX_TICKS }),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    };
    store.campaigns.push(row);
    await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('the database went away');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(row.tick).toBe(recorded);
    expect(row.stoppedReason).toContain(`has taken ${recorded} ticks`);
    // Both sentences, about one ceiling, agreeing with the column beside them.
    expect(row.stoppedReason).toContain(`hard ceiling of ${CLOSE_LOOP_MAX_TICKS}`);
  });

  /*
   * ── A TERMINAL CAMPAIGN WHOSE `nextTickAt` IS NOT NULL ────────────────────
   *
   * "Leaves a campaign that has stopped alone, for ever" seeds `nextTickAt:
   * null`, so it is the NEXT-TICK half of the sweep's `where` doing all the
   * work there and the STATE half was never exercised — dropping
   * `state: 'RUNNING'` from both the read and the claim left that test green.
   *
   * The row this rules out is not hypothetical: `GapClosure.state` has a whole
   * comment about hand-written UPDATEs in psql, and the same hands reach this
   * table. A campaign filed SETTLED or TICK_CEILING with a stale `nextTickAt`
   * — set by an operator, a restored backup, or a half-applied write — must be
   * ignored on its state alone, because reviving a terminal campaign is the
   * one thing this file's header says cannot happen: it would tick past its own
   * ceiling and spend budget a stop rule had already refused.
   *
   * Every terminal state, not just one, since the sweep names RUNNING rather
   * than excluding a list and a new member of CLOSURE_CAMPAIGN_STATES must
   * inherit the stop for free.
   */
  it('ignores a terminal campaign on its state alone, even with a tick still due', async () => {
    const due = new Date(NOW.getTime() - 60_000);
    for (const state of ['SETTLED', 'TICK_CEILING', 'BUDGET_SPENT', 'TARGET_MET', 'BLOCKED', 'UNMEASURABLE', 'NOTHING_LEFT']) {
      store.campaigns.push({ ...campaign({ id: `camp_${state}` }), state, nextTickAt: due });
    }

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: stubRecompute([40]).recompute,
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(sweep.advanced).toBe(0);
    expect(sweep.failed).toBe(0);
    // Not even CLAIMED: the claim's own `where` names RUNNING too, so a row
    // the read let through could not be advanced either. `nextTickAt` is
    // untouched, which is how we know nothing tried.
    for (const row of store.campaigns) {
      expect(row.nextTickAt).toEqual(due);
      expect(row.tick).toBe(0);
    }
  });

  /*
   * ── WHEN THE WRITE THAT ENFORCES THE CEILING IS THE THING THAT FAILS ──────
   *
   * `recordFailedTick` ends in a catch, and it has to: this sweep is contracted
   * never to throw, and a rejection escaping it would take the cron schedules
   * and the production monitors down with the campaign.
   *
   * But that write is the ONLY thing that increments `tick` on the failure path
   * and the only thing that writes TICK_CEILING and nulls `nextTickAt` — so if
   * it fails, the campaign is RUNNING at its old tick with `nextTickAt` already
   * pushed forward by its own claim, and the sweep collects it again in fifteen
   * minutes having counted nothing. That is the same unbounded campaign the
   * ceiling exists to rule out, reached by the failure of the fix rather than by
   * the original bug, and `.catch(() => undefined)` made it invisible: the
   * tick's own error is logged by the caller, and the fact that nothing could be
   * written down about it was logged nowhere.
   *
   * A failure suppressed is allowed here. A failure suppressed without being
   * counted is not.
   */
  it('says so when it could not even record the failed tick', async () => {
    const db = makeDb();
    store.campaigns.push({
      ...campaign({ tick: CLOSE_LOOP_MAX_TICKS }),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    });
    h.prisma = {
      ...db,
      closureCampaign: {
        ...(db.closureCampaign as Row),
        // The read and the claim still work; only the recording write fails,
        // which is the case that otherwise vanishes.
        update: async () => {
          throw new Error('deadlock detected');
        },
      },
    };

    const sweep = await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('the database went away');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    // Still never throws, and the tick is still counted as failed.
    expect(sweep.failed).toBe(1);

    const unrecorded = h.log.find((entry) =>
      entry.msg.includes('could not record a failed closure tick'),
    );
    expect(unrecorded).toBeDefined();
    expect(unrecorded!.level).toBe('error');
    /*
     * Both errors, because the two facts a reader needs are "the tick failed"
     * and "and we could not write that down" — and `wouldHaveBeenTerminal` is
     * the one that says the ceiling did not advance for this row.
     */
    expect(unrecorded!.obj).toMatchObject({
      campaignId: 'camp_1',
      projectId: 'proj_1',
      tick: CLOSE_LOOP_MAX_TICKS + 1,
      tickErr: 'the database went away',
      wouldHaveBeenTerminal: true,
    });
  });

  it('leaves a campaign that failed below the ceiling running, so a blip is not fatal', async () => {
    const row: Row = {
      ...campaign({ tick: 3 }),
      state: 'RUNNING',
      nextTickAt: new Date(NOW.getTime() - 1000),
    };
    store.campaigns.push(row);

    await advanceClosureCampaigns(NOW, {
      recompute: async () => {
        throw new Error('redis hiccup');
      },
      gapReport: stubGapReport(),
      generatorAvailable: true,
      now: () => NOW,
    });

    expect(row.state).toBe('RUNNING');
    expect(row.tick).toBe(4);
    // Pushed forward by the claim, not nulled: the campaign retries on its own
    // schedule rather than being punished for one bad tick.
    expect(row.nextTickAt).toEqual(new Date(NOW.getTime() + CLOSE_LOOP_TICK_MS));
    expect(row.finishedAt).toBeUndefined();
  });

  it('survives a database that cannot be read at all', async () => {
    h.prisma = {
      project: {
        findMany: async () => {
          throw new Error('no connection');
        },
      },
      closureCampaign: {
        findMany: async () => {
          throw new Error('no connection');
        },
      },
    };

    const sweep = await advanceClosureCampaigns(NOW);
    // `moreDue: false` and not `true`: a database that could not be read told
    // us nothing about how many campaigns are due, and guessing "more" would be
    // a claim made out of our own silence.
    expect(sweep).toEqual({ armed: 0, advanced: 0, failed: 0, moreDue: false });
    expect(h.log.some((entry) => entry.level === 'error')).toBe(true);
  });
});
