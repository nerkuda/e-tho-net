/**
 * Generic REST envelope wrappers, audit log and export-job types.
 *
 * Wire shapes defined by docs/03-server-api.md §2, §14, §15.
 */

import type { AuditCategory, ExportFormat, JobStatus } from '../enums.js';
import type { EtnErrorBody } from '../errors.js';

/** Optional metadata returned on a single-item success response. */
export interface SuccessMeta {
  /** Entity version after the change. */
  version?: number;
  /** ISO-8601 UTC. */
  updated_at?: string;
  /** Echoes the `Client-Request-Id` header of the request. */
  request_id?: string;
}

/** Single-item success envelope: `{ data, meta }` (03-server-api.md §2). */
export interface ApiSuccess<T> {
  data: T;
  meta?: SuccessMeta;
}

/** Pagination metadata returned on list responses. */
export interface ListMeta {
  total: number;
  offset: number;
  limit: number;
}

/** List success envelope: `{ data: [...], meta: { total, offset, limit } }`. */
export interface ApiList<T> {
  data: T[];
  meta: ListMeta;
}

/** Error envelope: `{ error: EtnErrorBody }` (03-server-api.md §2). */
export interface ApiError {
  error: EtnErrorBody;
}

/** Any top-level API response envelope (success / list / error). */
export type ApiResponse<T> = ApiSuccess<T> | ApiList<T> | ApiError;

/** Response of `GET /api/v1/health` (03-server-api.md §16). */
export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
}

/** Response of `GET /api/v1/version` (03-server-api.md §16–17). */
export interface VersionResponse {
  version: string;
  /** Semver range of client versions considered compatible. */
  client_compatibility: string;
}

/** audit_log row (02-data-model.md §2.6, 03-server-api.md §15). */
export interface AuditLogEntry {
  /** Autoincrement integer id. */
  id: number;
  /** ISO-8601 UTC. */
  ts: string;
  /** `null` for system-initiated actions. */
  actor_user_id: string | null;
  /** `null` for server-wide operations. */
  network_id: string | null;
  category: AuditCategory;
  /** e.g. `create`, `update`, `delete`, `grant`, `revoke`, `login`, `init`. */
  action: string;
  /** e.g. `user`, `network`, `thought`. */
  target_type: string | null;
  target_id: string | null;
  /** JSON details (already parsed). */
  details: unknown;
}

/** Query parameters of `GET /admin/audit` (03-server-api.md §15). */
export interface AuditQuery {
  actor?: string;
  network?: string;
  category?: AuditCategory;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** Body of `POST /export` (03-server-api.md §14). */
export interface ExportRequest {
  thought_ids: string[];
  format: ExportFormat;
}

/** Status snapshot of an export job (03-server-api.md §14). */
export interface ExportJob {
  job_id: string;
  status: JobStatus;
  /** Present once the job reaches `done`; short-lived URL with TTL. */
  download_url?: string;
}
