import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted((): { prisma: Record<string, unknown>; proposalDiff: string; auto: boolean } => ({
  prisma: {},
  proposalDiff: '',
  auto: true,
}));

vi.mock('../context.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  prisma: new Proxy({}, { get: (_t, k: string) => h.prisma[k] }),
  llm: {},
  publishEvent: () => {},
}));

vi.mock('@qaai/agent', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    triageFailure: async () => ({
      verdict: 'INTENDED_CHANGE',
      confidence: 0.9,
      explanation: 'selector renamed',
      evidence: [],
      suspectCommit: null,
      model: 'stub',
    }),
    proposeHeal: async () => ({
      diff: h.proposalDiff,
      explanation: 'retarget the total',
      riskLevel: 'LOW',
      confidence: 0.9,
    }),
    isAutoApprovable: () => ({ allowed: h.auto, reason: 'selector-only' }),
  };
});

const { processTriage } = await import('./triage.js');

const CODE = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('checkout charges the right total', async ({ page }) => {",
  "  await page.goto('/checkout');",
  "  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  '});',
].join('\n');

const SLEEP_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -4,1 +4,2 @@',
  "   await page.goto('/checkout');",
  '+  await page.waitForTimeout(500);',
].join('\n');

const BREAK_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -6,1 +6,1 @@',
  '-});',
  '+}',
].join('\n');

const CLEAN_DIFF = [
  '--- a/tests/checkout.spec.ts',
  '+++ b/tests/checkout.spec.ts',
  '@@ -5,1 +5,1 @@',
  "-  await expect(page.getByTestId('order-total')).toHaveText('$42.00');",
  "+  await expect(page.getByTestId('checkout-total')).toHaveText('$42.00');",
].join('\n');

function harness(diff: string, filePath = 'tests/checkout.spec.ts') {
  h.proposalDiff = diff;
  h.auto = true;
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  h.prisma = {
    testResult: {
      findFirst: async () => ({
        id: 'tr1',
        testId: 't1',
        orgId: 'org',
        status: 'FAILED',
        durationMs: 1,
        createdAt: new Date(),
        network: [],
        consoleLog: [],
        videoKey: null,
        traceKey: null,
        errorMessage: 'x',
        retriedAndPassed: false,
        findings: [],
        verdict: null,
        steps: [],
        test: {
          id: 't1',
          projectId: 'p1',
          name: 'checkout',
          filePath,
          code: CODE,
          type: 'E2E',
          spec: null,
        },
      }),
      findMany: async () => [],
    },
    triageVerdict: { create: async () => ({ id: 'v1' }) },
    project: { findUnique: async () => ({ autoApproveSelectorHeals: true }) },
    flowMap: { findFirst: async () => null },
    testVersion: { findFirst: async () => ({ version: 3 }) },
    test: {
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return {};
      },
    },
    healProposal: {
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return {};
      },
    },
  };
  return { created, updates };
}

describe('triage auto-apply wiring', () => {
  it('auto-applies a clean heal and records the checks in the version message', async () => {
    const { created, updates } = harness(CLEAN_DIFF);
    await processTriage({ orgId: 'org', runId: 'r1', testResultId: 'tr1' } as never);

    expect(created[0]!.state).toBe('AUTO_APPLIED');
    expect(updates).toHaveLength(1);
    const msg = (updates[0] as any).data.versions.create.message as string;
    expect(msg).toContain('Checked after patching');
    expect(msg).toContain('no fixed sleep');
  });

  it('refuses to auto-apply a heal that adds a fixed sleep, and says why', async () => {
    const { created, updates } = harness(SLEEP_DIFF);
    await processTriage({ orgId: 'org', runId: 'r1', testResultId: 'tr1' } as never);

    expect(created[0]!.state).toBe('PROPOSED');
    expect(updates).toHaveLength(0);
    expect(created[0]!.explanation).toMatch(/Auto-apply was declined/);
    expect(created[0]!.explanation).toMatch(/sleeps for a fixed duration/);
    expect(created[0]!.explanation).toMatch(/Checked after patching/);
  });

  it('refuses a heal that does not parse', async () => {
    const { created, updates } = harness(BREAK_DIFF);
    await processTriage({ orgId: 'org', runId: 'r1', testResultId: 'tr1' } as never);

    expect(created[0]!.state).toBe('PROPOSED');
    expect(updates).toHaveLength(0);
    expect(created[0]!.explanation).toMatch(/does not parse/);
  });
});
