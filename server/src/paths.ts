/**
 * Filesystem path helpers for ETN server data and bundled migrations.
 *
 * Runtime layout (docs/01-architecture.md §4):
 *
 * ```
 * <ETN_DATA_DIR>/                 ← absolute, from env
 * ├── _system.db
 * ├── _system.db-wal / -shm
 * ├── users/                      ← server-level user files (ADR a5888535)
 * │   └── <user-uuid>/
 * │       └── files/              ← e.g. map_wallpaper
 * └── networks/
 *     └── <network-uuid>/
 *         └── data.db
 * ```
 *
 * `users/` holds files of the server-level user (table `user_files`, entity
 * 62fd29b5): outside any network, NOT part of the automatic DB backup — the
 * source stays with the user and the server copy is restored by re-uploading.
 *
 * `dataDir` is always passed in explicitly (resolved by `config.ts`) so this
 * module stays free of process-env reads and is trivially testable. The bundled
 * migration directories are resolved relative to the `@etn/server` package root
 * (located by walking up from this file to the nearest `package.json`), which
 * works both under `tsx` (file in `src/`) and the compiled build (in `dist/`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Name of the system-wide SQLite database file. */
export const SYSTEM_DB_FILENAME = '_system.db';

/** Name of the per-network SQLite database file. */
export const NETWORK_DB_FILENAME = 'data.db';

/** Subdirectory holding every network's data. */
export const NETWORKS_DIRNAME = 'networks';

/**
 * Walk up from `moduleUrl` to the nearest directory containing a `package.json`,
 * i.e. the `@etn/server` package root. Robust to whether this file lives under
 * `src/` (tsx) or `dist/` (compiled).
 */
function resolvePackageDir(moduleUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate @etn/server package.json above ${moduleUrl}; migration paths are unavailable.`,
      );
    }
    dir = parent;
  }
}

/** Absolute path to the `@etn/server` package root (computed once at import). */
const PACKAGE_DIR = resolvePackageDir(import.meta.url);

/**
 * Absolute path to the `_system.db` file under the given data directory.
 *
 * @param dataDir - absolute ETN data directory.
 */
export function systemDbPath(dataDir: string): string {
  return path.join(dataDir, SYSTEM_DB_FILENAME);
}

/** Absolute path to the `networks/` root under the given data directory. */
export function networksRoot(dataDir: string): string {
  return path.join(dataDir, NETWORKS_DIRNAME);
}

/** Absolute path to a single network's directory. */
export function networkDir(dataDir: string, networkId: string): string {
  return path.join(networksRoot(dataDir), networkId);
}

/** Absolute path to a single network's `data.db` file. */
export function networkDbPath(dataDir: string, networkId: string): string {
  return path.join(networkDir(dataDir, networkId), NETWORK_DB_FILENAME);
}

/** Subdirectory holding server-level user files (outside any network). */
export const USERS_DIRNAME = 'users';

/** Absolute path to the `users/` root under the given data directory. */
export function usersRoot(dataDir: string): string {
  return path.join(dataDir, USERS_DIRNAME);
}

/** Absolute path to a single user's directory (`users/<user-uuid>`). */
export function userDir(dataDir: string, userId: string): string {
  return path.join(usersRoot(dataDir), userId);
}

/**
 * Absolute path to a user's files directory (`users/<user-uuid>/files`), where
 * `user_files` rows of this server keep their bytes (entity 62fd29b5,
 * ADR a5888535).
 */
export function userFilesDir(dataDir: string, userId: string): string {
  return path.join(userDir(dataDir, userId), 'files');
}

/** Absolute path to the bundled `_system.db` migrations directory. */
export function systemMigrationsDir(): string {
  return path.join(PACKAGE_DIR, 'migrations', 'system');
}

/** Absolute path to the bundled per-network `data.db` migrations directory. */
export function networkMigrationsDir(): string {
  return path.join(PACKAGE_DIR, 'migrations', 'network');
}
