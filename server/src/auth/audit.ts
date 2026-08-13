/**
 * Audit-log helper (task B14, 02-data-model.md §2.6, 06-auth.md §8–9).
 *
 * `recordAudit` is the canonical entry point for writing `audit_log` rows from
 * any layer (routes, auth, MCP). It is a thin, typed wrapper over
 * {@link SystemDb.insertAuditLog}: same storage, but a stable signature and an
 * optional debug log so callers do not sprinkle `insertAuditLog` calls directly.
 *
 * Categories and the {@link AuditEntry} shape mirror @etn/shared.
 */

import type { AuditCategory } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';

/** Input for {@link recordAudit}. */
export interface RecordAuditParams {
  /** User performing the action; `null`/omitted for the system actor. */
  actorUserId?: string | null;
  /** Network context; `null`/omitted for server-wide operations. */
  networkId?: string | null;
  category: AuditCategory;
  /** e.g. `create`, `update`, `delete`, `api_key.create`, `login_failed`. */
  action: string;
  /** e.g. `user`, `network`, `api_key`. */
  targetType?: string | null;
  targetId?: string | null;
  /** Any JSON-serialisable value; stored as TEXT. */
  details?: unknown;
}

/**
 * Append an `audit_log` row. Failures are caught and warned (audit must never
 * break the business operation that triggered it) unless `throwOnError` is set.
 *
 * @param systemDb - open `_system.db` accessor.
 * @param params - what to record.
 * @param logger - optional logger for failure diagnostics.
 */
export function recordAudit(
  systemDb: SystemDb,
  params: RecordAuditParams,
  logger?: Logger,
  throwOnError: boolean = false,
): void {
  try {
    systemDb.insertAuditLog({
      actorUserId: params.actorUserId,
      networkId: params.networkId,
      category: params.category,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      details: params.details,
    });
  } catch (err) {
    if (throwOnError) {
      throw err;
    }
    logger?.warn(
      { err, action: params.action, category: params.category },
      'audit: failed to record entry',
    );
  }
}
