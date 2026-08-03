/**
 * Env parsing. Fails loudly at boot rather than at the first request — a missing
 * VAULT_MASTER_KEY should stop the process, not surface as a 500 an hour later.
 */

import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const base64Key = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === bytes;
      } catch {
        return false;
      }
    }, `must be ${bytes} bytes of base64 (openssl rand -base64 ${bytes})`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().default('http://localhost:3000'),

  SESSION_SECRET: z.string().min(32, 'generate with: openssl rand -base64 48'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),

  VAULT_MASTER_KEY: base64Key(32),

  ANTHROPIC_API_KEY: z.string().default(''),
  QAAI_MODEL_CHEAP: z.string().default('claude-haiku-4-5'),
  QAAI_MODEL_STRONG: z.string().default('claude-opus-5'),
  QAAI_LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  QAAI_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(0),

  ARTIFACTS_LOCAL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('qaai-artifacts'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  DEMO_PUBLIC_URL: z.string().default('http://localhost:5050'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  /**
   * Which Stripe price sells which plan. Absent means "not purchasable online" —
   * the correct state for a self-hosted install, and permanently for Enterprise.
   */
  STRIPE_PRICE_TEAM: z.string().default(''),
  STRIPE_PRICE_BUSINESS: z.string().default(''),

  GITHUB_WEBHOOK_SECRET: z.string().default(''),

  /**
   * Outbound email. SMTP_HOST is the switch: set it and lib/mail.ts sends for
   * real, leave it and the same module writes the message to the log instead.
   *
   * There is deliberately no "enabled" flag. A boolean that can disagree with
   * the host it guards is one more way for mail to be silently off, and the
   * host is the thing an operator actually has or does not have.
   */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('QAAI <no-reply@qaai.local>'),

  /*
   * SLACK_WEBHOOK_URL, LINEAR_API_KEY and SENTRY_DSN used to be declared here.
   * All three were parsed at boot and then referenced by nothing — no `env.`
   * read anywhere in apps/ or packages/, no Sentry SDK in any package.json, and
   * Slack and Linear are per-organisation Integration rows with vault-sealed
   * credentials, which is the only shape that works when two orgs on one install
   * point at two different workspaces.
   *
   * A key in this schema is a promise that setting it does something. Removing
   * them is the honest half of that promise; the other half is that removal is
   * behaviour-preserving, because every one of them had `.default('')` and no
   * consumer. `npm run check:wiring` fails if one comes back unconsumed.
   */
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Not the logger — the logger depends on this module.
  console.error(`Invalid environment.\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

export const isProd = env.NODE_ENV === 'production';
