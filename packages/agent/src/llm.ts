/**
 * The single chokepoint for every LLM call in QAAI (§0).
 *
 * Responsibilities:
 *  - Model routing: a cheap model for exploration and first-pass triage, a
 *    strong model for generation and ambiguous verdicts.
 *  - Structured output: callers hand in a zod schema and get back a validated
 *    object. A hallucinated shape fails exactly like a malformed HTTP body.
 *  - Retries with backoff on transient failures, and one schema-repair retry
 *    when the model returns valid JSON of the wrong shape.
 *  - Token accounting per org, so §9 usage metering and the cost ceiling work.
 *  - Secret masking on every prompt before it leaves the process (§1).
 *
 * Nothing else in the codebase imports the Anthropic SDK directly.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { maskSecrets } from '@qaai/shared';
import type { AgentCallRecord, TokenUsage } from '@qaai/shared';

// ─── Model catalogue ─────────────────────────────────────────────────────────

/**
 * USD per million tokens. Cache reads bill at 0.1x input, 5-minute cache writes
 * at 1.25x input. Keep in sync with platform.claude.com/docs/en/pricing.
 */
interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL

/** Unknown model: bill at the most expensive known rate rather than under-report. */
function priceFor(model: string): ModelPricing {
  return PRICING[model] ?? { inputPerMTok: 5, outputPerMTok: 25 };
}

export type ModelTier = 'cheap' | 'strong';

/**
 * Effort maps to how hard the model works before answering. Exploration and
 * triage are cheap and frequent; generation and healing are where correctness
 * is worth paying for.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface LlmConfig {
  apiKey: string;
  cheapModel: string;
  strongModel: string;
  maxRetries: number;
  /** 0 disables the ceiling. Enforced by the caller-supplied budget check. */
  monthlyTokenBudget: number;
}

export interface CallContext {
  orgId: string;
  projectId: string | null;
  agent: AgentCallRecord['agent'];
  /** Correlation id — runId, planId, chat message id. */
  subjectId?: string | null;
  /**
   * Secret values in play. Masked out of the prompt before the request leaves
   * this process, so a credential in a page's DOM never reaches the API.
   */
  secrets?: Iterable<string>;
}

/** Called after every attempt, success or failure, so cost of failure is visible. */
export type UsageSink = (record: AgentCallRecord & { error?: string }) => void | Promise<void>;

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'AUTH' | 'RATE_LIMIT' | 'REFUSAL' | 'SCHEMA' | 'TRANSPORT' | 'BUDGET',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'LlmError';
  }
}

// ─── JSON Schema shaping ─────────────────────────────────────────────────────

/**
 * The structured-output engine accepts a restricted JSON Schema subset: no
 * numeric or string constraints, and every object must declare
 * `additionalProperties: false`. zod emits the richer form, so we normalise.
 *
 * The dropped constraints are not lost — the zod schema still validates the
 * response on the way back, so `.min(1)` is enforced client-side.
 */
const UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
] as const;

function normaliseJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normaliseJsonSchema);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = normaliseJsonSchema(value);
  }

  if (out.type === 'object') {
    out.additionalProperties = false;
    // Every property must be required; optionality is expressed with a null union.
    const props = out.properties as Record<string, unknown> | undefined;
    if (props && !out.required) out.required = Object.keys(props);
  }
  return out;
}

function toStructuredSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' });
  return normaliseJsonSchema(raw) as Record<string, unknown>;
}

// ─── The service ─────────────────────────────────────────────────────────────

export interface CompleteOptions {
  tier: ModelTier;
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: Effort;
  /**
   * Marks the system prompt as cacheable. Worth it whenever the same system
   * prompt is reused across a crawl or a batch of triage calls.
   */
  cacheSystem?: boolean;
}

export interface StructuredOptions<T extends z.ZodType> extends CompleteOptions {
  schema: T;
  /** Name shown in error messages when validation fails. */
  schemaName: string;
}

export class LlmService {
  private readonly client: Anthropic;

  constructor(
    private readonly config: LlmConfig,
    private readonly sink: UsageSink = () => {},
  ) {
    if (!config.apiKey) {
      // Deliberately not thrown at construction: the API boots fine without a
      // key, and only agent routes should fail. The message names the fix.
      this.client = new Anthropic({ apiKey: 'missing', maxRetries: 0 });
    } else {
      // The SDK's own retry handles 429/5xx; ours handles schema repair on top.
      this.client = new Anthropic({ apiKey: config.apiKey, maxRetries: config.maxRetries });
    }
  }

  private modelFor(tier: ModelTier): string {
    return tier === 'cheap' ? this.config.cheapModel : this.config.strongModel;
  }

  private assertConfigured(): void {
    if (!this.config.apiKey) {
      throw new LlmError(
        'ANTHROPIC_API_KEY is not set — add it to .env to enable the agent',
        'AUTH',
      );
    }
  }

  /** Free-text completion. Used by the chat copilot and by explanation prose. */
  async complete(ctx: CallContext, opts: CompleteOptions): Promise<string> {
    const { text } = await this.request(ctx, opts, null);
    return text;
  }

  /**
   * Schema-constrained completion. Returns a value already validated against
   * `opts.schema`, so callers never hand-parse model output.
   *
   * On a validation failure we retry once with the zod issues fed back to the
   * model — in practice that recovers the majority of near-miss shapes, and
   * failing twice is a genuine signal that the prompt or schema is wrong.
   */
  async structured<T extends z.ZodType>(
    ctx: CallContext,
    opts: StructuredOptions<T>,
  ): Promise<z.infer<T>> {
    const jsonSchema = toStructuredSchema(opts.schema);

    const first = await this.request(ctx, opts, jsonSchema);
    const parsed = this.validate(opts.schema, first.text, opts.schemaName);
    if (parsed.ok) return parsed.value;

    const repairPrompt =
      `${opts.prompt}\n\n` +
      `Your previous response did not match the required schema. ` +
      `Fix exactly these problems and return the corrected JSON:\n${parsed.issues}`;

    const second = await this.request(ctx, { ...opts, prompt: repairPrompt }, jsonSchema);
    const retried = this.validate(opts.schema, second.text, opts.schemaName);
    if (retried.ok) return retried.value;

    throw new LlmError(
      `${opts.schemaName} failed schema validation twice:\n${retried.issues}`,
      'SCHEMA',
    );
  }

  private validate<T extends z.ZodType>(
    schema: T,
    text: string,
    name: string,
  ): { ok: true; value: z.infer<T> } | { ok: false; issues: string } {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, issues: `${name}: response was not valid JSON` };
    }

    const result = schema.safeParse(json);
    if (result.success) return { ok: true, value: result.data };

    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    return { ok: false, issues };
  }

  private async request(
    ctx: CallContext,
    opts: CompleteOptions,
    jsonSchema: Record<string, unknown> | null,
  ): Promise<{ text: string }> {
    this.assertConfigured();

    const model = this.modelFor(opts.tier);
    const secrets = ctx.secrets ?? [];
    const system = maskSecrets(opts.system, secrets);
    const prompt = maskSecrets(opts.prompt, secrets);

    const startedAt = Date.now();

    try {
      const response = await this.client.beta.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 16000,
        // Opus 5 declines a small slice of requests outright; routing the
        // refusal to the recommended fallback keeps a run from dying on one.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {
          effort: opts.effort ?? (opts.tier === 'cheap' ? 'low' : 'high'),
          ...(jsonSchema ? { format: { type: 'json_schema' as const, schema: jsonSchema } } : {}),
        },
        system: opts.cacheSystem
          ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
          : system,
        messages: [{ role: 'user', content: prompt }],
      });

      const usage = this.accountFor(model, response.usage);
      await this.sink({
        ...usage,
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        agent: ctx.agent,
        subjectId: ctx.subjectId ?? null,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmError(
          'The model declined this request, and the fallback declined it too',
          'REFUSAL',
        );
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (!text.trim()) {
        throw new LlmError(`Empty response from ${model}`, 'TRANSPORT');
      }
      return { text };
    } catch (err) {
      if (err instanceof LlmError) throw err;

      await this.sink({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        agent: ctx.agent,
        subjectId: ctx.subjectId ?? null,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 0,
        durationMs: Date.now() - startedAt,
        at: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });

      if (err instanceof Anthropic.AuthenticationError) {
        throw new LlmError('ANTHROPIC_API_KEY was rejected', 'AUTH', err);
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new LlmError('Rate limited by the Anthropic API', 'RATE_LIMIT', err);
      }
      throw new LlmError(
        err instanceof Error ? err.message : 'Unknown LLM transport failure',
        'TRANSPORT',
        err,
      );
    }
  }

  private accountFor(model: string, usage: Anthropic.Beta.BetaUsage): TokenUsage {
    const price = priceFor(model);
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;

    const dollars =
      (input / 1e6) * price.inputPerMTok +
      (output / 1e6) * price.outputPerMTok +
      (cacheRead / 1e6) * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      (cacheWrite / 1e6) * price.inputPerMTok * CACHE_WRITE_MULTIPLIER;

    return {
      model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costCents: Math.round(dollars * 100 * 1e4) / 1e4,
    };
  }
}

/** Convenience factory reading the standard env vars. */
export function createLlmService(
  env: {
    ANTHROPIC_API_KEY: string;
    QAAI_MODEL_CHEAP: string;
    QAAI_MODEL_STRONG: string;
    QAAI_LLM_MAX_RETRIES: number;
    QAAI_MONTHLY_TOKEN_BUDGET: number;
  },
  sink?: UsageSink,
): LlmService {
  return new LlmService(
    {
      apiKey: env.ANTHROPIC_API_KEY,
      cheapModel: env.QAAI_MODEL_CHEAP,
      strongModel: env.QAAI_MODEL_STRONG,
      maxRetries: env.QAAI_LLM_MAX_RETRIES,
      monthlyTokenBudget: env.QAAI_MONTHLY_TOKEN_BUDGET,
    },
    sink,
  );
}
