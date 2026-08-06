/**
 * Budget-gate tests.
 *
 * The gate is a comparison and an error, and both halves have a failure mode
 * worth naming. Get the comparison wrong in one direction and the ceiling
 * lets "one more" call through forever; get it wrong in the other and the
 * env default of 0 — which means "no ceiling was ever set" — locks every
 * install out of the agent on day one. Get the error wrong and an operator
 * staring at a refused job knows neither how far over they are nor which
 * knob raises the limit.
 *
 * The service-level cases prove the refusal happens BEFORE any request is
 * built: the spend lookup is the only I/O the call performs, so a gate that
 * ran after the request would surface as a transport or auth failure here,
 * never as BUDGET.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError, LlmService, assertWithinTokenBudget } from './llm.js';

// ─── The comparison ──────────────────────────────────────────────────────────

describe('assertWithinTokenBudget', () => {
  it('never throws when the budget is 0 — the env default means no ceiling', () => {
    expect(() => assertWithinTokenBudget(0, 0)).not.toThrow();
    expect(() => assertWithinTokenBudget(0, Number.MAX_SAFE_INTEGER)).not.toThrow();
  });

  it('allows spend strictly under the budget', () => {
    expect(() => assertWithinTokenBudget(1_000_000, 0)).not.toThrow();
    expect(() => assertWithinTokenBudget(1_000_000, 999_999)).not.toThrow();
  });

  it('refuses AT the budget, not one past it — a ceiling that lets one more through is not a ceiling', () => {
    expect(() => assertWithinTokenBudget(1_000_000, 1_000_000)).toThrow(LlmError);
  });

  it('refuses past the budget', () => {
    expect(() => assertWithinTokenBudget(1_000_000, 2_500_000)).toThrow(LlmError);
  });

  // ── The error ──

  it('throws the BUDGET kind, so callers that already sort LlmError by kind handle it', () => {
    try {
      assertWithinTokenBudget(100, 100);
      expect.unreachable('the gate should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('BUDGET');
    }
  });

  it('names the spend, the budget, and the knob that raises it', () => {
    try {
      assertWithinTokenBudget(1_000_000, 1_234_567);
      expect.unreachable('the gate should have thrown');
    } catch (err) {
      const message = (err as LlmError).message;
      expect(message).toContain('1,234,567'); // the spend
      expect(message).toContain('1,000,000'); // the budget
      expect(message).toContain('QAAI_MONTHLY_TOKEN_BUDGET'); // where to raise it
    }
  });
});

// ─── The service refuses before it spends ────────────────────────────────────

const CONFIG = {
  apiKey: 'test-key-never-sent', // the gate must fire before this could be used
  cheapModel: 'claude-haiku-4-5',
  strongModel: 'claude-opus-5',
  maxRetries: 0,
  monthlyTokenBudget: 1_000,
};

const CTX = { orgId: 'org-1', projectId: null, agent: 'GENERATOR' as const };

describe('LlmService budget enforcement', () => {
  it('complete() refuses over budget, consulting the spend lookup for the right org', async () => {
    const asked: string[] = [];
    const service = new LlmService(CONFIG, undefined, async (orgId) => {
      asked.push(orgId);
      return 1_000;
    });

    await expect(
      service.complete(CTX, { tier: 'cheap', system: 'sys', prompt: 'hi' }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'BUDGET' });
    expect(asked).toEqual(['org-1']);
  });

  it('structured() refuses through the same gate', async () => {
    const service = new LlmService(CONFIG, undefined, async () => 2_000);

    await expect(
      service.structured(CTX, {
        tier: 'strong',
        system: 'sys',
        prompt: 'hi',
        schema: z.object({ ok: z.boolean() }),
        schemaName: 'Probe',
      }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'BUDGET' });
  });

  it('runToolLoop() refuses before its first round', async () => {
    const service = new LlmService(CONFIG, undefined, async () => 1_500);

    await expect(
      service.runToolLoop(CTX, {
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'BUDGET' });
  });

  it('never consults the spend lookup when no budget is set — zero must cost zero reads', async () => {
    const asked: string[] = [];
    const service = new LlmService(
      { ...CONFIG, apiKey: '', monthlyTokenBudget: 0 },
      undefined,
      async (orgId) => {
        asked.push(orgId);
        return 0;
      },
    );

    // The missing key throws AFTER the (skipped) budget check would have run;
    // AUTH here proves the gate stood down rather than masked a different error.
    await expect(
      service.complete(CTX, { tier: 'cheap', system: 'sys', prompt: 'hi' }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'AUTH' });
    expect(asked).toEqual([]);
  });

  it('a missing key outranks the budget — the operator should hear about the key first', async () => {
    // Both guards would fire; assertConfigured sits first on purpose, since a
    // keyless install can never spend and "over budget" would be a lie.
    const service = new LlmService({ ...CONFIG, apiKey: '' }, undefined, async () => 99_999);

    await expect(
      service.complete(CTX, { tier: 'cheap', system: 'sys', prompt: 'hi' }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'AUTH' });
  });
});
