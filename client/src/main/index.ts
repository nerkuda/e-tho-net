/**
 * Electron main process entry point (docs/07-client-electron.md §2).
 *
 * Responsibilities (expanded across G1–G8):
 *  - creates the application `BrowserWindow` (1280×800);
 *  - loads the Vite dev server in development, the packaged renderer in prod;
 *  - owns the local SQLite store (G3), `client_id` (G4) and the network/realtime
 *    clients (G5/G6) — wired in later tasks;
 *  - registers the `etn://open?…` custom protocol (task R11) so other apps
 *    (Obsidian, browsers) can deep-link into a specific thought.
 *
 * The API-key never leaves this process: renderer talks to data exclusively over
 * IPC (G7).
 */
import { app, BrowserWindow, protocol, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_META_KEY, type DeepLink } from '@etn/shared';
import { LocalDb } from './db/local-db.js';
import { defaultMigrationsDir, localDbPath } from './db/paths.js';
import { getOrCreateClientId } from './client-id.js';
import { registerIpc } from './ipc/register.js';
import { dispatchDeepLink, extractDeepLink } from './ipc/deep-link.js';
import { initAutoUpdater } from './updater.js';

/**
 * Directory of the compiled main bundle (`out/main`). Renderer and preload
 * artefacts sit next to it under `out/`, so relative `../renderer` and
 * `../preload` paths resolve both in dev (electron-vite) and in prod.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `true` when launched via `electron-vite dev`, `false` once packaged. */
const isDev = !app.isPackaged;

// Local-image protocol (`etnimg://c/pics/img.png`): serves attachment files
// from disk. Registered as privileged/secure so BOTH the dev http origin and
// the packaged file:// page may load these images — a plain file:// URL is
// blocked for http pages ("Not allowed to load local resource").
//
// `etn` (task R11): the deep-link custom protocol. We don't actually serve
// any content for it — the URL is parsed in main (`parseDeepLink`) and the
// payload is pushed to the renderer over `etn:deep-link`. Registering the
// scheme with `standard: true` is required for `app.setAsDefaultProtocolClient`
// to take effect, and `secure: true` lets the dev origin dispatch the URL
// without mixed-content warnings. `supportFetchAPI: false` because we don't
// want `fetch('etn://…')` to succeed — these URLs are only meaningful as
// navigation events.
protocol.registerSchemesAsPrivileged([
  { scheme: 'etnimg', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'etn', privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

/**
 * Register ETN as the default handler for `etn://` URLs (task R11). Idempotent
 * — calling twice doesn't add another association. On Windows the dev path is
 * the Electron binary inside the project; on macOS the helper registers the
 * `Info.plist` `CFBundleURLTypes` entry.
 */
if (process.defaultApp && process.argv.length >= 2) {
  // Dev: re-exec the script with the URL as argv[1] (Windows protocol
  // dispatch passes the URL as argv, not via app.on('second-instance')).
  app.setAsDefaultProtocolClient('etn', process.execPath, [
    require('node:path').resolve(process.argv[1]!),
  ]);
} else {
  app.setAsDefaultProtocolClient('etn');
}

/** Default window geometry (docs/07-client-electron.md §1, workplan G1). */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/**
 * Local SQLite store (G3). Opened once on app ready and closed on quit. Held at
 * module scope so IPC handlers (G7) and network clients (G5/G6) can share it.
 */
let localDb: LocalDb | null = null;

/** Window background per theme; matches the `--bg` tokens in styles.css (L10). */
const THEME_BG: Record<'light' | 'dark', string> = {
  light: '#eef0f4',
  dark: '#0e1116',
};

/**
 * Deep-link payload captured at cold start (task R11) before the main window
 * exists. On Win/Linux the URL is in `process.argv`; on macOS it arrives
 * asynchronously via `app.on('open-url')`. We buffer it here and dispatch
 * once the renderer is ready.
 */
let pendingDeepLink: DeepLink | null = null;

/** Reads the stored L5 theme, defaulting to light. */
function storedTheme(db: LocalDb): 'light' | 'dark' {
  return db.getMeta(CLIENT_META_KEY.THEME) === 'dark' ? 'dark' : 'light';
}

/**
 * Creates and configures the main application window.
 *
 * Security posture: `contextIsolation` on, `nodeIntegration` off, `sandbox` off —
 * the renderer has no direct Node access and reaches the main process only
 * through the preload `contextBridge` (see `src/preload/index.ts`). `sandbox`
 * is disabled because Electron's sandboxed loader cannot import the ESM preload
 * bundle; see the inline comment at the `sandbox` field below.
 */
function createWindow(theme: 'light' | 'dark'): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title: 'ETN',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: THEME_BG[theme],
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
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

    return win;
}

/** Content types for files served over the `etnimg` protocol. */
const ETNIMG_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  // Text attachments («Показать» in the attachment context menu, L1).
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
};

/**
 * Serves `etnimg://<drive>/<path…>` from the local filesystem (read-only).
 * The URL host is a single drive letter (Windows) or the first path segment
 * (absolute POSIX path); `..`/`.` segments are rejected.
 */
function registerEtnimgProtocol(): void {
  protocol.handle('etnimg', (request) => {
    const url = new URL(request.url);
    const host = decodeURIComponent(url.hostname).toLowerCase();
    const segments = decodeURIComponent(url.pathname)
      .split('/')
      .filter((s) => s !== '' && s !== '.' && s !== '..');
    if (host === '' || !/^[a-z]$/.test(host) || segments.length === 0) {
      return new Response('bad etnimg path', { status: 400 });
    }
    const filePath = path.join(`${host}:`, ...segments);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return new Response('not a file', { status: 404 });
      }
      const ext = filePath.toLowerCase().split('.').pop() ?? '';
      return new Response(readFileSync(filePath), {
        headers: {
          'Content-Type': ETNIMG_TYPES[ext] ?? 'application/octet-stream',
          'Cache-Control': 'max-age=3600',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/**
 * App lifecycle. macOS re-creates a window on dock activation when none remain;
 * other platforms quit when all windows are closed (standard Electron idiom).
 */
app
  .whenReady()
  .then(() => {
    // Single-instance lock (task R11): when a second `etn://open?…` arrives
    // while we're already running, the OS spawns a new process that hands its
    // argv to this one via `app.on('second-instance')` (Win/Linux) instead of
    // opening another window. macOS uses `app.on('open-url')` for the same
    // effect. Acquire the lock here, *after* `app.whenReady()` so the
    // setAsDefaultProtocolClient call above has taken effect.
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      // Another instance is already running — it will receive our argv via
      // `second-instance` (handled below) and bring its window forward. We
      // exit cleanly so the user doesn't see a duplicate UI.
      app.quit();
      return;
    }

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

    registerEtnimgProtocol();

    // Wire the renderer bridge (G7): single `etn:invoke` channel + realtime
    // event/status broadcast to whichever window is front-most.
    registerIpc({
      localDb,
      clientId,
      getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    });

    // Window background follows the stored theme so the very first paint
    // already matches (the renderer applies data-theme on boot, L10).
    const theme = storedTheme(localDb);

    const win = createWindow(theme);

    // Pick up a deep link from this process's argv (Win/Linux cold start:
    // the OS launches the registered protocol handler with the URL appended
    // as the last argument). Buffer it — the renderer may not be ready yet.
    const initial = extractDeepLink(process.argv);
    if (initial !== null) {
      pendingDeepLink = initial;
      win.webContents.once('did-finish-load', () => {
        if (pendingDeepLink !== null) {
          dispatchDeepLink(win, pendingDeepLink);
          pendingDeepLink = null;
        }
      });
    }

    // Auto-update (K4): quiet check in packaged builds; inert in dev.
    void initAutoUpdater(!isDev, () => BrowserWindow.getAllWindows()[0] ?? null);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(theme);
    });
  })
  .catch((err: unknown) => {
    // Surface boot failures before the window exists; Electron itself exits next.
    console.error('[ETN] Failed to start:', err);
  });

/**
 * Win/Linux: another instance was launched (typically by the OS opening an
 * `etn://open?…` URL while we're already running). Pull the deep link from
 * its argv and forward to the renderer; also bring our window to the front.
 */
app.on('second-instance', (_event, argv) => {
  const link = extractDeepLink(argv);
  const win = BrowserWindow.getAllWindows()[0];
  if (win !== undefined) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (link !== null) dispatchDeepLink(win, link);
  }
});

/**
 * macOS: an `etn://open?…` URL was opened (from Finder, browser, Obsidian
 * deep-link, etc.). argv does not contain the URL on macOS — it arrives via
 * this event. We buffer and dispatch when the window is ready (cold start)
 * or directly (warm start, window exists).
 */
app.on('open-url', (event, url) => {
  event.preventDefault();
  const link = extractDeepLink([url]);
  if (link === null) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined) {
    pendingDeepLink = link;
  } else {
    dispatchDeepLink(win, link);
  }
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
