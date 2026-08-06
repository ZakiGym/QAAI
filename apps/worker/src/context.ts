/**
 * Shared worker infrastructure: env, logging, database, storage, LLM, and the
 * Redis channel the API's SSE endpoint listens on.
 */

import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import IORedis from 'ioredis';
import pino from 'pino';
import { PrismaPg } from '@prisma/adapter-pg';
import { createStorage, defaultLocalArtifactRoot } from '@qaai/storage';
import { createLlmService } from '@qaai/agent';
import { maskDeep } from '@qaai/shared';
import type { AgentCallRecord } from '@qaai/shared';
// The generated client lives in the API workspace; the worker shares the schema
// rather than maintaining a second copy of the data model.
import { PrismaClient } from '../../api/src/generated/prisma/client.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  artifactsLocal: process.env.ARTIFACTS_LOCAL === 'true',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  vaultMasterKey: required('VAULT_MASTER_KEY'),
};

export const logger = pino({
  level: config.logLevel,
  base: { service: 'qaai-worker' },
  formatters: { level: (label) => ({ level: label }), log: (o) => maskDeep(o) },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

/**
 * No tenancy extension here, and that is deliberate: the worker drains jobs
 * across every org, and each processor scopes its own queries by the orgId on
 * the job. Wrapping this client in the API's extension would make the queue
 * undrainable.
 */
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});

export const storage = createStorage({
  backend: config.artifactsLocal ? 'local' : 's3',
  bucket: process.env.S3_BUCKET ?? 'qaai-artifacts',
  rootDir: defaultLocalArtifactRoot(),
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  localPublicBaseUrl: process.env.API_PUBLIC_URL ?? 'http://localhost:4000',
});

export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const publisher = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const EVENTS_CHANNEL = 'qaai:events';

/**
 * Run events cross the process boundary through Redis; the API relays them to
 * the cockpit over SSE. Publishing is fire-and-forget — a dropped progress
 * event must never fail a run.
 */
export function publishEvent(orgId: string, event: Record<string, unknown>): void {
  void publisher.publish(EVENTS_CHANNEL, JSON.stringify({ orgId, event })).catch((err) => {
    logger.warn({ err }, 'failed to publish run event');
  });
}

/** Writes one AgentCall row per LLM call and rolls tokens into monthly usage (§0, §9). */
async function recordAgentCall(record: AgentCallRecord & { error?: string }): Promise<void> {
  try {
    await prisma.agentCall.create({
      data: {
        orgId: record.orgId,
        projectId: record.projectId,
        agent: record.agent,
        model: record.model,
        subjectId: record.subjectId,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        costCents: record.costCents,
        durationMs: record.durationMs,
        error: record.error ?? null,
      },
    });

    const total = record.inputTokens + record.outputTokens;
    if (total > 0) {
      const now = new Date();
      const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await prisma.usageRecord.upsert({
        where: { orgId_metric_period: { orgId: record.orgId, metric: 'agent_tokens', period } },
        create: { orgId: record.orgId, metric: 'agent_tokens', period, quantity: BigInt(total) },
        update: { quantity: { increment: BigInt(total) } },
      });
    }
  } catch (err) {
    logger.error({ err }, 'failed to record agent call');
  }
}

/**
 * Month-to-date tokens for the budget gate — read from the same row
 * recordAgentCall increments, so the ceiling can never disagree with the
 * meter. BigInt → Number is safe here: a month that overflows 2^53 tokens is
 * nine quadrillion of them, which is not a month anyone is having.
 */
async function monthTokens(orgId: string): Promise<number> {
  const now = new Date();
  const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const row = await prisma.usageRecord.findUnique({
    where: { orgId_metric_period: { orgId, metric: 'agent_tokens', period } },
    select: { quantity: true },
  });
  return Number(row?.quantity ?? 0n);
}

export const llm = createLlmService(
  {
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    QAAI_MODEL_CHEAP: process.env.QAAI_MODEL_CHEAP ?? 'claude-haiku-4-5',
    QAAI_MODEL_STRONG: process.env.QAAI_MODEL_STRONG ?? 'claude-opus-5',
    QAAI_LLM_MAX_RETRIES: Number(process.env.QAAI_LLM_MAX_RETRIES ?? 3),
    QAAI_MONTHLY_TOKEN_BUDGET: Number(process.env.QAAI_MONTHLY_TOKEN_BUDGET ?? 0),
  },
  recordAgentCall,
  monthTokens,
);
