/**
 * Rebuilds the root `better-sqlite3` (the copy the Electron client uses) for
 * Electron — by downloading its Electron prebuilt binary. No Python / node-gyp.
 *
 * Why not `electron-rebuild`: it walks the whole npm-workspaces dependency tree
 * and would also rebuild `server/node_modules/better-sqlite3` (needed under
 * Node), breaking the server. `prebuild-install` scoped to the root copy touches
 * only what the client loads.
 *
 * The `build/` marker left by a previous prebuild makes prebuild-install skip
 * the download, so the directory is removed first. npm workspaces hoists
 * better-sqlite3 to the repository root, hence the ../.. path.
 */
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootNm = path.resolve(here, '..', '..', 'node_modules');
const sqliteDir = path.join(rootNm, 'better-sqlite3');
const electronVer = JSON.parse(
  readFileSync(path.join(rootNm, 'electron', 'package.json'), 'utf8'),
).version;

rmSync(path.join(sqliteDir, 'build'), { recursive: true, force: true });
console.log(
  `[rebuild:native] downloading better-sqlite3 Electron ${electronVer} prebuilt into ${sqliteDir}`,
);

// `npx` + shell:true resolves the prebuild-install binary reliably across
// Windows/cmd and Unix; the direct .bin path is flaky under spawnSync on Win.
spawnSync(
  'npx',
  ['prebuild-install', '-r', 'electron', '-t', electronVer],
  { cwd: sqliteDir, stdio: 'inherit', shell: true },
);

// prebuild-install's exit code is unreliable across platforms; treat the
// unpacked binary as the source of truth.
const nodeFile = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
if (existsSync(nodeFile)) {
  console.log('[rebuild:native] OK — Electron prebuilt installed');
  process.exit(0);
}
console.error('[rebuild:native] FAILED — no native binary produced');
process.exit(1);
