/**
 * Auto-update wiring (task K4, docs/07-client-electron.md §8).
 *
 * Uses `electron-updater` against GitHub Releases (see
 * `client/electron-builder.yml`, `publish` section). Update checks run only in
 * packaged builds — in development the module is inert so the dev loop is never
 * interrupted.
 *
 * Behaviour: check on startup (quiet, no user prompt on failure), install on
 * quit. User-facing events are forwarded to the renderer over the
 * `update:status` broadcast.
 */

import type { AppUpdater } from 'electron-updater';
import type { BrowserWindow } from 'electron';

/**
 * Starts the auto-update loop. Safe to call in dev (`isPackaged=false` returns
 * immediately).
 */
export async function initAutoUpdater(
  isPackaged: boolean,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  // electron-updater is meaningless outside a packaged build: `app-update.yml`
  // does not exist in dev, and a check would just fail noisily.
  if (!isPackaged) {
    return;
  }
  try {
    // Dynamic import: electron-updater reads app-update.yml next to the
    // executable, so it is only resolvable in packaged builds.
    //
    // `electron-updater` is CommonJS; under ESM the CJS namespace lands on
    // `default`, while its `autoUpdater` export is an accessor property that
    // Node's CJS-ESM interop does not re-expose as a named export — destructure
    // it from `default`, not from the module namespace.
    const updaterModule = (await import('electron-updater')) as unknown as {
      default: { autoUpdater: AppUpdater };
    };
    const { autoUpdater } = updaterModule.default;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:status', 'available');
      }
    });
    autoUpdater.on('update-downloaded', () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:status', 'downloaded');
      }
    });
    autoUpdater.on('error', (err: Error) => {
      // Never crash the app because the updater failed — log and continue.
      console.warn('[ETN] auto-update error:', err.message);
    });

    // `checkForUpdates` rejects (e.g. missing `app-update.yml` in unpacked
    // builds) instead of emitting `error` — swallow the rejection the same way.
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.debug('[ETN] auto-update check failed:', err);
    });
  } catch (err) {
    // Missing dependency outside packaged builds — expected, not an error.
    console.debug('[ETN] auto-update unavailable:', err);
  }
}
