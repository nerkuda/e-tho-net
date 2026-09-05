/**
 * Generic REST envelope wrappers, audit log and export-job types.
 *
 * Wire shapes defined by docs/03-server-api.md §2, §14, §15.
 */

import type { AuditCategory, ExportFormat, JobStatus } from '../enums.js';
import type { EtnErrorBody } from '../errors.js';
import type { LayerEcho } from './layer.js';

/** Optional metadata returned on a single-item success response. */
export interface SuccessMeta {
  /** Entity version after the change. */
  version?: number;
  /** ISO-8601 UTC. */
  updated_at?: string;
  /** Echoes the `Client-Request-Id` header of the request. */
  request_id?: string;
  /**
   * Echo of the session's current layer (task S7, 13-layers.md §7.1): every
   * mutating REST response of a network carries it, so a write landing in a
   * foreign layer is discoverable immediately. Injected centrally by the
   * server's onSend hook — route handlers do not fill it manually.
   */
  layer?: LayerEcho;
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

/**
 * Options applied only to `format: 'etnx'` exports (phase P, docs/02-data-model.md §9).
 * Markdown/HTML/PDF exports ignore these fields.
 */
export interface ExportEtnxOptions {
  /** Include `thought_types` and `link_types` in `manifest.json`. Default: true. */
  include_types?: boolean;
  /** Include binary attachments inside `attachments/` (and their rows in
   *  `manifest.attachments`). Default: true. */
  include_attachments?: boolean;
  /** Include chronological comments and their `comment_targets`. Default: true. */
  include_chronology?: boolean;
  /** Include the descendants of every root thought in `thought_ids` (BFS by
   *  outgoing parent→child links). Default: false. */
  include_subtree?: boolean;
  /** Maximum descendant depth when `include_subtree` is true. 1..5. Default: 1. */
  subtree_depth?: number;
}

/** Body of `POST /export` (03-server-api.md §14). */
export interface ExportRequest {
  thought_ids: string[];
  format: ExportFormat;
  /** Required when `format === 'etnx'`; ignored otherwise. */
  etnx?: ExportEtnxOptions;
}

/** Status snapshot of an export job (03-server-api.md §14). */
export interface ExportJob {
  job_id: string;
  status: JobStatus;
  /** Present once the job reaches `done`; short-lived URL with TTL. */
  download_url?: string;
}

/**
 * Options for the `.etnx` import dialog (phase P, task P6). All toggles default
 * to `true`; users can disable a slice of the archive (e.g. drop attachments)
 * before committing.
 */
export interface ImportEtnxOptions {
  /** Import `thought_types` / `link_types` (default true). */
  include_types?: boolean;
  /** Import `attachments` (default true). */
  include_attachments?: boolean;
  /** Import `chronological` comments (default true). */
  include_chronology?: boolean;
}

/**
 * Body of `POST /networks/{nid}/import/commit` (03-server-api.md §14а, phase P,
 * task P4). The `.etnx` archive is sent as a base64-encoded string because the
 * REST envelope is JSON.
 */
export interface ImportRequest {
  /** Base64-encoded contents of the `.etnx` zip file. */
  archive_b64: string;
  /**
   * UUID of the thought the imported subgraph is attached to as children.
   * The import creates a parent→child link for every root thought in the
   * archive (those without an incoming link inside the archive).
   */
  parent_thought_id: string;
  /** Slices of the manifest to import. Unspecified → all slices (defaults). */
  etnx?: ImportEtnxOptions;
}

/**
 * Per-entity counters returned by the import endpoint (phase P, P3).
 * Surfaces the effect of the dedup policy without forcing the caller to
 * diff the resulting graph.
 */
export interface ImportSummary {
  thought_types_created: number;
  thought_types_reused: number;
  link_types_created: number;
  link_types_reused: number;
  /** Registry properties (`properties` table, 0.6.5) newly created. */
  properties_created: number;
  /** Type bindings (`type_properties`) newly created. */
  property_definitions_created: number;
  thoughts_created: number;
  thoughts_updated: number;
  thoughts_reused: number;
  links_created: number;
  permanent_comments_updated: number;
  chronological_comments_added: number;
  property_values_set: number;
  attachments_imported: number;
  /** Manifest version echoed back for the caller to log. */
  manifest_version: string;
}

/**
 * Body of `POST /networks/{nid}/import/preview` (03-server-api.md §14а, P4).
 * Reports what *would* be imported without committing anything.
 */
export interface ImportPreview {
  /** Detected format version of the manifest. */
  manifest_version: string;
  /** Source network the archive was exported from. */
  source_network_name: string | null;
  /** Totals as reported by the manifest. */
  counts: {
    thought_types: number;
    link_types: number;
    /** Registry properties (0.6.5). */
    properties: number;
    type_properties: number;
    thoughts: number;
    thought_synonyms: number;
    links: number;
    comments: number;
    attachments: number;
  };
}
