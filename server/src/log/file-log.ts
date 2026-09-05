/**
 * Plain-text file journal for server diagnostics (task 1dd33e23).
 *
 * Writes daily files `server-YYYY-MM-DD.log` (UTC) under
 * `<ETN_DATA_DIR>/logs/`, one line per entry:
 *
 * ```
 * 2026-09-04T12:34:56.789Z ERROR [http] request failed method=GET path=/api/v1/x status=500
 * ```
 *
 * Rules (spec: подсистема «Логирование» in the ETN knowledge network):
 *   * ERROR entries are written **always**, regardless of the flag — the
 *     journal must capture failures even while diagnostics are off;
 *   * WARN/INFO/DEBUG are written only while the in-memory flag is on;
 *   * the flag lives in memory only: a restarted server starts with logging
 *     off and never persists the state anywhere;
 *   * files older than {@link RETENTION_DAYS} days are removed on startup and
 *     on every daily rollover;
 *   * the current daily file is truncated (not unlinked) on deletion so the
 *     journal keeps filling the same file.
 *
 * This journal is deliberately separate from the stdout pino logger:
 * `ETN_LOG_LEVEL` keeps governing stdout only.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SystemLogFileMeta } from '@etn/shared';

/** How many daily files are kept before the auto-cleanup removes them. */
export const RETENTION_DAYS = 30;

/** Directory name under the data dir holding the journal files. */
export const LOGS_DIRNAME = 'logs';

/** Strict `server-YYYY-MM-DD.log` shape — the path-traversal guard for the REST routes. */
export const LOG_FILENAME_RE = /^server-\d{4}-\d{2}-\d{2}\.log$/;

/** Journal levels; ordering matters only for documentation. */
export type FileLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Constructor options (both fields exist for testability). */
export interface FileLogOptions {
  /**
   * Clock override — tests use it to simulate a day rollover. Defaults to
   * `() => new Date()`.
   */
  now?: () => Date;
}

/** Structured fields of one entry, rendered as `key=value` pairs. */
export type FileLogFields = Record<string, string | number | boolean | null>;

/** Result of {@link FileLog.deleteFile}. */
export type DeleteFileResult = 'deleted' | 'truncated' | null;

/** Outcome of {@link FileLog.deleteAll}. */
export interface DeleteAllResult {
  /** Files physically unlinked. */
  deleted: number;
  /** The current daily file — truncated in place, not deleted. */
  truncated: number;
}

/**
 * The file journal. Construct once per server process (in `createServer`),
 * share via the `app.fileLog` decorator.
 */
export class FileLog {
  private readonly logDir: string;
  private readonly now: () => Date;

  /** In-memory logging flag; always off at construction (never persisted). */
  private enabledFlag = false;

  /** Date (YYYY-MM-DD) the current file belongs to; set on first write. */
  private currentDate: string | null = null;

  /** Set once the directory has been created; avoids repeated mkdir calls. */
  private dirEnsured = false;

  constructor(dataDir: string, options?: FileLogOptions) {
    this.logDir = path.join(dataDir, LOGS_DIRNAME);
    this.now = options?.now ?? (() => new Date());
  }

  /** Absolute journal directory (exposed via `GET /system/logging`). */
  get dir(): string {
    return this.logDir;
  }

  /** Current in-memory flag state. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Flip the in-memory flag. The change itself is always journaled (WARN,
   * bypassing the flag — the audit of who toggled the journal must not be
   * lost by the very act of turning it off).
   */
  setEnabled(value: boolean, actor?: string): void {
    const changed = this.enabledFlag !== value;
    this.enabledFlag = value;
    this.writeDirect(
      'WARN',
      'logging',
      value ? 'file logging enabled' : 'file logging disabled',
      { ...(actor === undefined ? {} : { user: actor }), enabled: value, ...(changed ? {} : { changed: false }) },
    );
  }

  /** DEBUG entry (only while enabled). */
  debug(component: string, message: string, fields?: FileLogFields): void {
    this.log('DEBUG', component, message, fields);
  }

  /** INFO entry (only while enabled). */
  info(component: string, message: string, fields?: FileLogFields): void {
    this.log('INFO', component, message, fields);
  }

  /** WARN entry (only while enabled). */
  warn(component: string, message: string, fields?: FileLogFields): void {
    this.log('WARN', component, message, fields);
  }

  /** ERROR entry — written even when the flag is off. */
  error(component: string, message: string, fields?: FileLogFields): void {
    this.log('ERROR', component, message, fields);
  }

  /** General entry: ERROR passes through, everything else needs the flag. */
  log(level: FileLogLevel, component: string, message: string, fields?: FileLogFields): void {
    if (level !== 'ERROR' && !this.enabledFlag) {
      return;
    }
    this.writeDirect(level, component, message, fields);
  }

  /**
   * Duration of one MCP tool call (INFO while enabled — agents compete with
   * REST for the same synchronous event loop, task 1dd33e23 §3).
   */
  mcpToolCall(tool: string, durationMs: number): void {
    this.info('mcp', 'tool call completed', { tool, duration_ms: Math.round(durationMs) });
  }

  /** Existing journal files, oldest first. Creates nothing. */
  listFiles(): SystemLogFileMeta[] {
    const names = this.existingLogNames();
    const files: SystemLogFileMeta[] = [];
    for (const name of names) {
      const date = name.slice('server-'.length, '.log'.length * -1);
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(path.join(this.logDir, name)).size;
      } catch {
        // vanished between readdir and stat — report as empty
      }
      files.push({ name, sizeBytes, date });
    }
    files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return files;
  }

  /** Read one journal file; `null` when it does not exist. */
  readFile(name: string): string | null {
    const file = path.join(this.logDir, name);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Delete one journal file. The current daily file is truncated in place
   * instead (the writer keeps appending to it). `null` when the file does
   * not exist. The action is always journaled.
   */
  deleteFile(name: string, actor?: string): DeleteFileResult {
    const file = path.join(this.logDir, name);
    if (!fs.existsSync(file)) {
      return null;
    }
    let result: DeleteFileResult;
    if (name === this.fileNameFor(this.today())) {
      fs.truncateSync(file, 0);
      result = 'truncated';
    } else {
      fs.rmSync(file);
      result = 'deleted';
    }
    this.writeDirect('WARN', 'logging', 'log file removed', {
      file: name,
      mode: result,
      ...(actor === undefined ? {} : { user: actor }),
    });
    return result;
  }

  /**
   * Delete every journal file; the current daily file is truncated. Always
   * journals the summary (after the truncation, so it lands in the fresh file).
   */
  deleteAll(actor?: string): DeleteAllResult {
    const currentName = this.fileNameFor(this.today());
    const result: DeleteAllResult = { deleted: 0, truncated: 0 };
    for (const name of this.existingLogNames()) {
      if (name === currentName) {
        fs.truncateSync(path.join(this.logDir, name), 0);
        result.truncated += 1;
      } else {
        fs.rmSync(path.join(this.logDir, name));
        result.deleted += 1;
      }
    }
    this.writeDirect('WARN', 'logging', 'all log files removed', {
      deleted: result.deleted,
      truncated: result.truncated,
      ...(actor === undefined ? {} : { user: actor }),
    });
    return result;
  }

  /** Remove files older than {@link RETENTION_DAYS} days (startup + rollover). */
  cleanupOldFiles(): number {
    const cutoff = this.today();
    const cutoffMs = Date.UTC(
      Number(cutoff.slice(0, 4)),
      Number(cutoff.slice(5, 7)) - 1,
      Number(cutoff.slice(8, 10)),
    );
    let removed = 0;
    for (const name of this.existingLogNames()) {
      const date = name.slice('server-'.length, '.log'.length * -1);
      const fileMs = Date.UTC(
        Number(date.slice(0, 4)),
        Number(date.slice(5, 7)) - 1,
        Number(date.slice(8, 10)),
      );
      if (cutoffMs - fileMs > RETENTION_DAYS * 86_400_000) {
        try {
          fs.rmSync(path.join(this.logDir, name));
          removed += 1;
        } catch {
          // best effort — a stuck file re-appears on the next sweep
        }
      }
    }
    return removed;
  }

  /** Is `name` a well-formed journal file name? (REST param validation.) */
  static isValidLogFilename(name: string): boolean {
    return LOG_FILENAME_RE.test(name);
  }

  /** Today's `YYYY-MM-DD` (UTC) per the injectable clock. */
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** `server-<YYYY-MM-DD>.log` for a date string. */
  private fileNameFor(date: string): string {
    return `server-${date}.log`;
  }

  /** Names in the journal dir matching the strict pattern (no throwing when the dir is absent). */
  private existingLogNames(): string[] {
    try {
      return fs
        .readdirSync(this.logDir)
        .filter((name) => LOG_FILENAME_RE.test(name));
    } catch {
      return [];
    }
  }

  /**
   * Append one line to the current daily file. Lazily creates the directory,
   * rolls the file over at a UTC-day change (running the retention sweep) and
   * never throws: a journaling failure must not take the server down.
   */
  private writeDirect(
    level: FileLogLevel,
    component: string,
    message: string,
    fields?: FileLogFields,
  ): void {
    try {
      const today = this.today();
      if (!this.dirEnsured) {
        fs.mkdirSync(this.logDir, { recursive: true });
        this.dirEnsured = true;
      }
      if (this.currentDate !== today) {
        const isFirstWrite = this.currentDate !== null;
        this.currentDate = today;
        if (isFirstWrite) {
          // Day rollover while the server keeps running: new file + retention.
          this.cleanupOldFiles();
        }
      }
      const line = formatLine(this.now(), level, component, message, fields);
      fs.appendFileSync(path.join(this.logDir, this.fileNameFor(today)), line + '\n');
    } catch (err) {
      // The journal itself is broken — surface on stderr (not pino stdout)
      // and keep serving; diagnostics must never become an outage.
      try {
        process.stderr.write(`etn file-log: write failed: ${String(err)}\n`);
      } catch {
        // nowhere to complain — give up silently
      }
    }
  }
}

/** Render `key=value` pairs; strings with whitespace/quotes are JSON-quoted. */
function formatValue(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' && /[\s"=]/.test(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Assemble one journal line. */
function formatLine(
  ts: Date,
  level: FileLogLevel,
  component: string,
  message: string,
  fields?: FileLogFields,
): string {
  const parts = [ts.toISOString(), level, `[${component}]`, message];
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  return parts.join(' ');
}
