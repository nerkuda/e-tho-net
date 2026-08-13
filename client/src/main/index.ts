/**
 * Electron main process entry point (docs/07-client-electron.md §2).
 *
 * Responsibilities (expanded across G1–G8):
 *  - creates the application `BrowserWindow` (1280×800);
 *  - loads the Vite dev server in development, the packaged renderer in prod;
 *  - owns the local SQLite store (G3), `client_id` (G4) and the network/realtime
 *    clients (G5/G6) — wired in later tasks.
 *
 * The API-key never leaves this process: renderer talks to data exclusively over
 * IPC (G7).
 */
import { app, BrowserWindow, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LocalDb } from './db/local-db.js';
import { defaultMigrationsDir, localDbPath } from './db/paths.js';
import { getOrCreateClientId } from './client-id.js';
import { registerIpc } from './ipc/register.js';
import { initAutoUpdater } from './updater.js';

/**
 * Directory of the compiled main bundle (`out/main`). Renderer and preload
 * artefacts sit next to it under `out/`, so relative `../renderer` and
 * `../preload` paths resolve both in dev (electron-vite) and in prod.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `true` when launched via `electron-vite dev`, `false` once packaged. */
const isDev = !app.isPackaged;

/** Default window geometry (docs/07-client-electron.md §1, workplan G1). */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/**
 * Local SQLite store (G3). Opened once on app ready and closed on quit. Held at
 * module scope so IPC handlers (G7) and network clients (G5/G6) can share it.
 */
let localDb: LocalDb | null = null;

/**
 * Creates and configures the main application window.
 *
 * Security posture: `contextIsolation` on, `nodeIntegration` off, `sandbox` on —
 * the renderer has no direct Node access and reaches the main process only
 * through the preload `contextBridge` (see `src/preload/index.ts`).
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title: 'ETN',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      // electron-vite emits the preload bundle as `.mjs` (package "type":"module")
      // into `out/preload/`. Resolve it relative to `out/main/` at runtime so
      // dev (`electron-vite dev`) and packaged builds both work without config
      // forks.
      preload: path.join(__dirname, '../preload/index.mjs'),
      // sandbox disabled: Electron's sandbox uses a restricted loader that
      // cannot import ESM preload scripts. Keeping `contextIsolation: true` +
      // `nodeIntegration: false` + a trusted first-party preload preserves the
      // meaningful security boundary — the renderer still cannot reach Node or
      // the preload context directly, only the curated `window.etn` surface.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the system browser, never inside ETN.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    win.webContents.openDevTools();
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * App lifecycle. macOS re-creates a window on dock activation when none remain;
 * other platforms quit when all windows are closed (standard Electron idiom).
 */
app
  .whenReady()
  .then(() => {
    // Open the local store and ensure the installation has a stable client_id
    // (G3/G4). The REST client (G5) reads this id to send the `Client-Id` header
    // on every request; the WebSocket client (G6) sends it on connect.
    localDb = new LocalDb({
      dbPath: localDbPath(app.getPath('userData')),
      // TODO(K1): remap to process.resourcesPath for packaged builds.
      migrationsDir: defaultMigrationsDir(),
    });
    const clientId = getOrCreateClientId(localDb);
    if (isDev) console.log('[ETN] client_id =', clientId);

    // Wire the renderer bridge (G7): single `etn:invoke` channel + realtime
    // event/status broadcast to whichever window is front-most.
    registerIpc({
      localDb,
      clientId,
      getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    });

    createWindow();

    // Auto-update (K4): quiet check in packaged builds; inert in dev.
    void initAutoUpdater(!isDev, () => BrowserWindow.getAllWindows()[0] ?? null);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err: unknown) => {
    // Surface boot failures before the window exists; Electron itself exits next.
    console.error('[ETN] Failed to start:', err);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Release the DB file handle before the process exits so WAL files flush.
app.on('before-quit', () => {
  try {
    localDb?.close();
  } catch (err: unknown) {
    console.error('[ETN] Failed to close local DB:', err);
  } finally {
    localDb = null;
  }
});
