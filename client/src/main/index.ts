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
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
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
    createWindow();

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
