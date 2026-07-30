/**
 * Structured logging (§1 SOC2 hygiene). Every log line goes through the secret
 * masker before it is serialised — see packages/shared/src/mask.ts.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { maskDeep } from '@qaai/shared';
import { env, isProd } from '../env.js';

/** Request-scoped context so log lines carry ids without threading them through calls. */
interface RequestStore {
  requestId: string;
  userId?: string;
  orgId?: string;
  /** Secret values in play for this request, masked out of every log line. */
  secrets: Set<string>;
}

const store = new AsyncLocalStorage<RequestStore>();

export function runWithRequestContext<T>(
  ctx: Partial<RequestStore> & { requestId?: string },
  fn: () => T,
): T {
  return store.run(
    {
      requestId: ctx.requestId ?? randomUUID(),
      userId: ctx.userId,
      orgId: ctx.orgId,
      secrets: ctx.secrets ?? new Set(),
    },
    fn,
  );
}

export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

export function setRequestActor(userId: string, orgId: string): void {
  const s = store.getStore();
  if (s) {
    s.userId = userId;
    s.orgId = orgId;
  }
}

/**
 * Registers secret values for the current request so they are masked from any
 * subsequent log line. Callers that decrypt from the vault must call this.
 */
export function registerRequestSecrets(values: Iterable<string>): void {
  const s = store.getStore();
  if (!s) return;
  for (const v of values) s.secrets.add(v);
}

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'qaai-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.valueEnc',
      '*.tokenHash',
    ],
    censor: '••••••••',
  },
  formatters: {
    level: (label) => ({ level: label }),
    // Mask every payload and stamp request context.
    log: (object) => {
      const s = store.getStore();
      const masked = maskDeep(object, s?.secrets ?? []);
      return s
        ? { ...(masked as object), requestId: s.requestId, userId: s.userId, orgId: s.orgId }
        : (masked as Record<string, unknown>);
    },
  },
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

export type Logger = typeof logger;
