import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './apps/api/src/generated/prisma/client.js';

const url = process.argv[2]!;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), log: [{ emit: 'event', level: 'query' }] });
let ms = 0; let n = 0; let rows = 0;
prisma.$on('query', (e) => { ms += e.duration; n += 1; });

const findings = () => prisma.finding.findMany({
  where: { orgId: 'org_1', testResult: { run: { projectId: 'proj_1_1' } }, mutedAt: null },
  orderBy: { createdAt: 'desc' }, take: 1000,
  select: { id: true, kind: true, severity: true, code: true, message: true, location: true, helpUrl: true, mutedAt: true, createdAt: true,
    testResult: { select: { id: true, runId: true, test: { select: { id: true, name: true } } } } },
});
await findings();
ms = 0; n = 0;
for (let i = 0; i < 10; i++) rows = (await findings()).length;
console.log(`findings: rows=${rows} queries=${n} total=${(ms/10).toFixed(2)}ms/call`);

// /settings/usage, 30-day window: old (findMany + JS) vs new (groupBy).
const since = new Date(Date.now() - 30 * 86_400_000);
let t = Date.now();
let calls = await prisma.agentCall.findMany({ where: { orgId: 'org_1', createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  select: { agent: true, model: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, costCents: true, durationMs: true, error: true, createdAt: true } });
let sum = 0; for (const c of calls) sum += c.costCents;
console.log(`usage OLD: ${calls.length} rows loaded, ${(Date.now()-t)}ms, totalCostCents=${sum.toFixed(2)}`);

t = Date.now();
const [totals, failures] = await Promise.all([
  prisma.agentCall.groupBy({ by: ['agent'], where: { orgId: 'org_1', createdAt: { gte: since } },
    _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, costCents: true } }),
  prisma.agentCall.groupBy({ by: ['agent'], where: { orgId: 'org_1', createdAt: { gte: since }, error: { not: null } }, _count: { _all: true } }),
]);
const newSum = totals.reduce((s, r) => s + (r._sum.costCents ?? 0), 0);
const newCalls = totals.reduce((s, r) => s + r._count._all, 0);
console.log(`usage NEW: ${totals.length + failures.length} rows loaded, ${(Date.now()-t)}ms, totalCostCents=${newSum.toFixed(2)}, totalCalls=${newCalls} (old ${calls.length})`);
const oldFail = calls.filter(c => c.error).length;
const newFail = failures.reduce((s, r) => s + r._count._all, 0);
console.log(`failures old=${oldFail} new=${newFail}`);
const oldIn = calls.reduce((s,c)=>s+c.inputTokens+c.cacheReadTokens,0);
const newIn = totals.reduce((s,r)=>s+(r._sum.inputTokens??0)+(r._sum.cacheReadTokens??0),0);
console.log(`inputTokens old=${oldIn} new=${newIn}`);
await prisma.$disconnect();
