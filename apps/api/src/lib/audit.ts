/**
 * Audit log (§1) — every mutating action, append-only.
 *
 * Writes are best-effort by design: an audit failure must not roll back the
 * user's action, but it must be loud. If you need an action that cannot proceed
 * without its audit row, write the row inside the same transaction instead.
 */

import { maskDeep } from '@qaai/shared';
import type { ActorContext } from '@qaai/shared';
import { prisma, unscoped } from './prisma.js';
import { currentRequestId, logger } from './logger.js';

export interface AuditInput {
  actor: Pick<ActorContext, 'userId' | 'orgId' | 'ip' | 'impersonatedBy'> & {
    userAgent?: string | null;
  };
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    // Unscoped: the row's orgId comes from the actor, and the audit writer must
    // work during org creation, before any tenant scope exists.
    await unscoped(() =>
      prisma.auditLog.create({
        data: {
          orgId: input.actor.orgId,
          userId: input.actor.userId || null,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          metadata: input.metadata ? (maskDeep(input.metadata) as object) : undefined,
          ip: input.actor.ip,
          userAgent: input.actor.userAgent ?? null,
          requestId: currentRequestId() ?? null,
          impersonatedBy: input.actor.impersonatedBy,
        },
      }),
    );
  } catch (err) {
    logger.error({ err, action: input.action }, 'audit write failed');
  }
}

/** CSV export for the Settings → Audit log screen (§1). */
export function auditRowsToCsv(
  rows: Array<{
    createdAt: Date;
    action: string;
    targetType: string;
    targetId: string | null;
    userId: string | null;
    ip: string | null;
    impersonatedBy: string | null;
    metadata: unknown;
  }>,
): string {
  const header = [
    'timestamp',
    'action',
    'target_type',
    'target_id',
    'user_id',
    'ip',
    'impersonated_by',
    'metadata',
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    // Guard against CSV injection when the file is opened in a spreadsheet.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.action,
        r.targetType,
        r.targetId,
        r.userId,
        r.ip,
        r.impersonatedBy,
        r.metadata,
      ]
        .map(escape)
        .join(','),
    );
  }
  return lines.join('\n');
}
