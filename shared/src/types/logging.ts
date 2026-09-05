/**
 * File-log (diagnostic journal) DTOs for the `/api/v1/system/logging` and
 * `/api/v1/system/logs` admin endpoints.
 *
 * The server keeps a plain-text daily journal under `<ETN_DATA_DIR>/logs/`
 * (`server-YYYY-MM-DD.log`) for diagnosing intermittent freezes: ERROR lines
 * are always written, everything else only while the in-memory logging flag
 * is on. The flag is never persisted — a restarted server starts with logging
 * off. These types define the wire shapes of the management endpoints.
 */

/** One daily journal file as listed by `GET /system/logging`. */
export interface SystemLogFileMeta {
  /** File name, `server-YYYY-MM-DD.log` (UTC date). */
  name: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** The `YYYY-MM-DD` part of the name (UTC). */
  date: string;
}

/** Status payload of `GET /system/logging` (and the reply of `PUT`). */
export interface SystemLoggingStatus {
  /** Whether non-ERROR levels are currently written to the journal. */
  enabled: boolean;
  /** Absolute path of the journal directory (`<ETN_DATA_DIR>/logs`). */
  logDir: string;
  /** How many daily files are retained before auto-cleanup. */
  retentionDays: number;
  /** Existing journal files, oldest first. Empty when none were written yet. */
  files: SystemLogFileMeta[];
}

/** Request body of `PUT /system/logging`. */
export interface SystemLoggingUpdateInput {
  /** New state of the in-memory logging flag. */
  enabled: boolean;
}
