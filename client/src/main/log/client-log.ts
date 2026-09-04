/**
 * Plain-text file journal of the Electron client main process (task f051bf95).
 *
 * Behavioural twin of the server journal (`server/src/log/file-log.ts`,
 * подсистема «Логирование»): same line format, same daily-rotation and
 * retention rules — implemented as independent client-side code (the server
 * module is not imported).
 *
 * Writes daily files `client-YYYY-MM-DD.log` (**local** date — the client
 * journal buckets by the user's day, unlike the server's UTC buckets) under
 * `<userData>/logs/`, one line per entry:
 *
 * ```
 * 2026-09-04T12:34:56.789Z ERROR [rest] request failed method=GET path=/me status=500
 * ```
 *
 * Rules:
 *   * ERROR entries are written **always**, regardless of the flag — the
 *     journal must capture failures even while diagnostics are off;
 *   * WARN/INFO/DEBUG are written only while the flag is on;
 *   * the flag, unlike the server's, is **persisted** in `client_meta.log_enabled`
 *     and restored on the next start; the `--logging`/`--no-logging` launch
 *     switches override it for the run and become the new stored value
 *     (see {@link resolveLoggingFlag} and `parseLoggingArg` in `db/paths.ts`);
 *   * files older than {@link RETENTION_DAYS} days are removed on init and on
 *     every daily rollover;
 *   * the current daily file is truncated (not unlinked) on deletion so the
 *     journal keeps filling the same file;
 *   * a journaling failure never throws — diagnostics must not take the app down.
 *
 * Line timestamps stay UTC ISO (`toISOString()`), exactly like the server
 * lines, so client and server journals are grep-compatible.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_META_KEY } from '@etn/shared';

/** How many daily files are kept before the auto-cleanup removes them. */
export const RETENTION_DAYS = 30;

/** Directory name under `userData` holding the journal files. */
export const LOGS_DIRNAME = 'logs';

/** Strict `client-YYYY-MM-DD.log` shape. */
export const LOG_FILENAME_RE = /^client-\d{4}-\d{2}-\d{2}\.log$/;

/** Journal levels; ordering matters only for documentation. */
export type ClientLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Structured fields of one entry, rendered as `key=value` pairs. */
export type ClientLogFields = Record<string, string | number | boolean | null>;

/** Constructor options (both fields exist for testability). */
export interface ClientLogOptions {
  /** Clock override — tests use it to simulate a day rollover. */
  now?: () => Date;
}

/** Outcome of {@link ClientLog.deleteAll}. */
export interface DeleteAllResult {
  /** Files physically unlinked. */
  deleted: number;
  /** The current daily file — truncated in place, not deleted. */
  truncated: number;
}

/** State payload of `system.getClientLogState` (07-client-electron.md). */
export interface ClientLogState {
  enabled: boolean;
  /** Absolute path of the current daily file (may not exist yet). */
  logFile: string;
  /** Absolute journal directory. */
  logDir: string;
}

/**
 * The client file journal. Own code, same behaviour as the server `FileLog`;
 * the crucial difference is the persistence contract of the flag (see the
 * module doc).
 */
export class ClientLog {
  private readonly logDir: string;
  private readonly now: () => Date;

  /** In-memory logging flag; off until the app restores the stored value. */
  private enabledFlag = false;

  /** Date (YYYY-MM-DD) the current file belongs to; set on first write. */
  private currentDate: string | null = null;

  /** Set once the directory has been created; avoids repeated mkdir calls. */
  private dirEnsured = false;

  constructor(userDataDir: string, options?: ClientLogOptions) {
    this.logDir = path.join(userDataDir, LOGS_DIRNAME);
    this.now = options?.now ?? (() => new Date());
  }

  /** Absolute journal directory. */
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
   * lost by the very act of turning it off). Persisting to `client_meta` is
   * the caller's job (the logger stays DB-free).
   */
  setEnabled(value: boolean, actor?: string): void {
    const changed = this.enabledFlag !== value;
    this.enabledFlag = value;
    this.writeDirect(
      'WARN',
      'logging',
      value ? 'file logging enabled' : 'file logging disabled',
      { ...(actor === undefined ? {} : { actor }), enabled: value, ...(changed ? {} : { changed: false }) },
    );
  }

  /** DEBUG entry (only while enabled). */
  debug(component: string, message: string, fields?: ClientLogFields): void {
    this.log('DEBUG', component, message, fields);
  }

  /** INFO entry (only while enabled). */
  info(component: string, message: string, fields?: ClientLogFields): void {
    this.log('INFO', component, message, fields);
  }

  /** WARN entry (only while enabled). */
  warn(component: string, message: string, fields?: ClientLogFields): void {
    this.log('WARN', component, message, fields);
  }

  /** ERROR entry — written even when the flag is off. */
  error(component: string, message: string, fields?: ClientLogFields): void {
    this.log('ERROR', component, message, fields);
  }

  /** General entry: ERROR passes through, everything else needs the flag. */
  log(level: ClientLogLevel, component: string, message: string, fields?: ClientLogFields): void {
    if (level !== 'ERROR' && !this.enabledFlag) {
      return;
    }
    this.writeDirect(level, component, message, fields);
  }

  /** Snapshot for `system.getClientLogState`. Creates nothing. */
  getState(): ClientLogState {
    return {
      enabled: this.enabledFlag,
      logFile: this.currentFilePath(),
      logDir: this.logDir,
    };
  }

  /**
   * Make sure the current daily file exists (touch it) and return its path —
   * used by `system.openClientLog` so the OS handler always has a real file.
   */
  ensureCurrentFile(): string {
    try {
      this.ensureDir();
      const file = this.currentFilePath();
      if (!fs.existsSync(file)) {
        fs.appendFileSync(file, '');
      }
      return file;
    } catch {
      // Unwritable location — still return the intended path; the caller's
      // openPath will surface the failure to the user.
      return this.currentFilePath();
    }
  }

  /** Absolute path of the current daily file. */
  currentFilePath(): string {
    return path.join(this.logDir, this.fileNameFor(this.today()));
  }

  /**
   * Delete every journal file; the current daily file is truncated in place
   * (the writer keeps appending to it). Always journals the summary — after
   * the truncation, so it lands in the fresh file.
   */
  deleteAll(actor?: string): DeleteAllResult {
    const currentName = this.fileNameFor(this.today());
    const result: DeleteAllResult = { deleted: 0, truncated: 0 };
    for (const name of this.existingLogNames()) {
      try {
        if (name === currentName) {
          fs.truncateSync(path.join(this.logDir, name), 0);
          result.truncated += 1;
        } else {
          fs.rmSync(path.join(this.logDir, name));
          result.deleted += 1;
        }
      } catch {
        // best effort — a stuck file re-appears on the next sweep
      }
    }
    this.writeDirect('WARN', 'logging', 'all log files removed', {
      deleted: result.deleted,
      truncated: result.truncated,
      ...(actor === undefined ? {} : { actor }),
    });
    return result;
  }

  /** Remove files older than {@link RETENTION_DAYS} days (startup + rollover). */
  cleanupOldFiles(): number {
    const cutoff = this.today();
    const cutoffMs = localDateToUtcMs(cutoff);
    let removed = 0;
    for (const name of this.existingLogNames()) {
      const date = name.slice('client-'.length, '.log'.length * -1);
      const fileMs = localDateToUtcMs(date);
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

  /** Today's `YYYY-MM-DD` (**local** date) per the injectable clock. */
  private today(): string {
    return localDateString(this.now());
  }

  /** `client-<YYYY-MM-DD>.log` for a date string. */
  private fileNameFor(date: string): string {
    return `client-${date}.log`;
  }

  /** Names in the journal dir matching the strict pattern (no throw when absent). */
  private existingLogNames(): string[] {
    try {
      return fs.readdirSync(this.logDir).filter((name) => LOG_FILENAME_RE.test(name));
    } catch {
      return [];
    }
  }

  private ensureDir(): void {
    if (!this.dirEnsured) {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.dirEnsured = true;
    }
  }

  /**
   * Append one line to the current daily file. Lazily creates the directory,
   * rolls the file over at a local-day change (running the retention sweep)
   * and never throws: a journaling failure must not take the client down.
   */
  private writeDirect(
    level: ClientLogLevel,
    component: string,
    message: string,
    fields?: ClientLogFields,
  ): void {
    try {
      const today = this.today();
      this.ensureDir();
      if (this.currentDate !== today) {
        const isFirstWrite = this.currentDate !== null;
        this.currentDate = today;
        if (isFirstWrite) {
          // Day rollover while the client keeps running: new file + retention.
          this.cleanupOldFiles();
        }
      }
      const line = formatLine(this.now(), level, component, message, fields);
      fs.appendFileSync(path.join(this.logDir, this.fileNameFor(today)), line + '\n');
    } catch (err) {
      // The journal itself is broken — surface on stderr and keep running;
      // diagnostics must never become an outage.
      try {
        process.stderr.write(`etn client-log: write failed: ${String(err)}\n`);
      } catch {
        // nowhere to complain — give up silently
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Launch-flag resolution (client_meta.log_enabled + --logging/--no-logging)
// ---------------------------------------------------------------------------

/** Outcome of {@link resolveLoggingFlag}. */
export interface LoggingFlagResolution {
  /** Effective flag for this run. */
  enabled: boolean;
  /** Where the value came from. */
  source: 'cli' | 'stored' | 'default';
  /**
   * `true` when the value must be (re)written to `client_meta.log_enabled`:
   * a CLI override always persists (it becomes the last explicitly set
   * value); a stored value needs no rewrite; the default (no key stored)
   * persists on the first toggle only — see {@link persistIfRequested}.
   */
  persist: boolean;
}

/**
 * Resolve the journal flag at startup: a `--logging`/`--no-logging` switch
 * overrides the stored `client_meta.log_enabled` value for this run AND
 * replaces it as the last explicitly set state; with no switch the stored
 * value wins; with neither the journal starts disabled (and the default is
 * not persisted until the user actually toggles something).
 *
 * @param cliFlag Result of `parseLoggingArg(process.argv)` (`null` when absent).
 * @param storedValue Raw `client_meta.log_enabled` string, or `null` when unset.
 */
export function resolveLoggingFlag(
  cliFlag: boolean | null,
  storedValue: string | null,
): LoggingFlagResolution {
  if (cliFlag !== null) {
    return { enabled: cliFlag, source: 'cli', persist: true };
  }
  if (storedValue === 'true') return { enabled: true, source: 'stored', persist: false };
  if (storedValue === 'false') return { enabled: false, source: 'stored', persist: false };
  return { enabled: false, source: 'default', persist: false };
}

/** `client_meta` key the flag lives in (re-exported for wiring sites). */
export const LOG_ENABLED_META_KEY = CLIENT_META_KEY.LOG_ENABLED;

// ---------------------------------------------------------------------------
// Module singleton (main-process instrumentation entry point)
// ---------------------------------------------------------------------------

let instance: ClientLog | null = null;

/**
 * Create the process-wide journal under `<userData>/logs` and run the
 * retention sweep. Called once from the main entry point right after the
 * `userData` path is final (the `--user-data-dir` switch is applied first).
 */
export function initClientLog(userDataDir: string, options?: ClientLogOptions): ClientLog {
  instance = new ClientLog(userDataDir, options);
  instance.cleanupOldFiles();
  return instance;
}

/** Process-wide journal, or `null` before `initClientLog` (tests, early boot). */
export function getClientLog(): ClientLog | null {
  return instance;
}

/** Reset the singleton (tests only). */
export function resetClientLogForTests(): void {
  instance = null;
}

/**
 * Render an arbitrary `data` payload as a compact single-line string for the
 * journal, truncated to `max` characters (milestone events from the renderer
 * must not flood the file with huge payloads).
 */
export function truncateForLog(value: unknown, max = 200): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` of a Date in the **local** timezone (client buckets by user day). */
function localDateString(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTC midnight of a `YYYY-MM-DD` string — retention arithmetic. */
function localDateToUtcMs(date: string): number {
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
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

/** Assemble one journal line (same shape as the server journal). */
function formatLine(
  ts: Date,
  level: ClientLogLevel,
  component: string,
  message: string,
  fields?: ClientLogFields,
): string {
  const parts = [ts.toISOString(), level, `[${component}]`, message];
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  return parts.join(' ');
}
