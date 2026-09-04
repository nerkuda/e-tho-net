/**
 * Filesystem locations for the client local SQLite store
 * (docs/07-client-electron.md §3, workplan G3).
 *
 * Production path lives under Electron's `userData` directory, which the main
 * process resolves via `app.getPath('userData')` and passes down to the DB
 * layer. This module is a pure path helper with no Electron dependency, so the
 * DB layer can be exercised from tests/typecheck without a live app. The
 * fallback `.dev/user-data` directory is used whenever code runs outside
 * Electron (unit tests, CLI helpers).
 */
import path from 'node:path';

/** Local SQLite database filename (07-client-electron.md §3). */
export const LOCAL_DB_FILENAME = 'local.db';

/**
 * Workspace-relative fallback `userData` directory used outside Electron
 * (typecheck, unit tests). Keeps the real `userData` untouched in dev.
 */
export const DEV_USER_DATA_DIR = path.join(process.cwd(), '.dev', 'user-data');

/**
 * Returns the absolute path of the local DB file inside a `userData` directory.
 * Pure helper — does not touch the filesystem.
 */
export function localDbPath(userDataDir: string): string {
  return path.join(userDataDir, LOCAL_DB_FILENAME);
}

/**
 * Parses the `--user-data-dir=<path>` CLI switch (docs/07-client-electron.md §3)
 * which points the whole local profile (local.db, server profiles, settings,
 * window bounds) at a separate directory.
 *
 * Returns the **absolute** profile directory, or `null` when the switch is
 * absent or carries no value (`--user-data-dir=`). Relative values resolve
 * against `process.cwd()`. Unknown arguments are ignored, and the switch may
 * appear at any position in `argv` — the main process scans the full
 * `process.argv` (in dev the Electron entry comes first, in packaged builds
 * the executable path does).
 */
export function parseUserDataDirArg(argv: string[]): string | null {
  const PREFIX = '--user-data-dir=';
  const flag = argv.find((a) => a.startsWith(PREFIX));
  if (flag === undefined) return null;
  const value = flag.slice(PREFIX.length);
  if (value === '') return null;
  return path.resolve(value);
}

/**
 * Parses the `--logging` / `--no-logging` CLI switches (docs/07-client-electron.md,
 * task f051bf95): they override the stored `client_meta.log_enabled` value for
 * this run and become the new stored value.
 *
 * Returns `true`/`false` for the effective override, or `null` when neither
 * switch is present. Only **exact tokens** match — Electron and Chromium inject
 * their own arguments (e.g. `--enable-logging`), so a prefix/substring match
 * would misfire. When both switches appear, the LAST one wins (standard CLI
 * semantics for repeated flags).
 */
export function parseLoggingArg(argv: string[]): boolean | null {
  const ENABLE = '--logging';
  const DISABLE = '--no-logging';
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (arg === ENABLE) return true;
    if (arg === DISABLE) return false;
  }
  return null;
}

/**
 * Default migrations directory.
 *
 * In development and tests `client/` is the working directory, so `./migrations`
 * resolves to `client/migrations`. Packaged builds unpack the migrations next to
 * the app (electron-builder `extraResources`) — the main process resolves them
 * as `process.resourcesPath/migrations` and passes the path here (see
 * `createWindow`'s caller in `index.ts`).
 */
export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), 'migrations');
}

/**
 * Migrations directory for packaged builds: the app's `resources/` folder,
 * where electron-builder's `extraResources` copies `client/migrations`.
 */
export function packagedMigrationsDir(): string {
  return path.join(process.resourcesPath, 'migrations');
}
