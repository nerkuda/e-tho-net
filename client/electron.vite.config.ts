/**
 * electron-vite configuration for @etn/client.
 *
 * Bundles three targets (docs/07-client-electron.md §2):
 *  - `main`    — Electron main process (Node runtime): сетевые операции, локальная
 *                БД, safeStorage, IPC-обработчики.
 *  - `preload` — contextBridge-скрипт,隔离ающий renderer от main.
 *  - `renderer`— Chromium UI (холст, редактор, диалоги).
 *
 * Entry points follow the electron-vite convention and need not be listed
 * explicitly: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`.
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  // Main process: externalise runtime deps (electron, better-sqlite3, @etn/shared)
  // so they resolve from node_modules at runtime instead of being bundled.
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: 'src/renderer',
  },
});
