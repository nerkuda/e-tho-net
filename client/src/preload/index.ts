/**
 * Preload script (docs/07-client-electron.md §2.1, §6).
 *
 * Runs in an isolated context with Node access and exposes a *deliberately
 * minimal* surface to the renderer via `contextBridge`. The full `window.etn`
 * contract (server, networks, thoughts, links, …) is wired in task **G7**.
 *
 * Security: the API-key, network clients and local DB live only in the main
 * process; the renderer never receives the raw key — every data call goes
 * through IPC.
 */
import { contextBridge } from 'electron';

// Empty placeholder so `window.etn` exists and stays typed. G7 populates it with
// the full method set described in docs/07-client-electron.md §6.
contextBridge.exposeInMainWorld('etn', {});
