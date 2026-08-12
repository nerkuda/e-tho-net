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
 * Default migrations directory.
 *
 * In development and tests `client/` is the working directory, so `./migrations`
 * resolves to `client/migrations`. For packaged builds (K1) this will be
 * remapped to `process.resourcesPath`; left for the packaging task.
 */
export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), 'migrations');
}
