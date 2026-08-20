/**
 * Classification of an «open externally» target — a URL-attachment address or
 * a `url` property value (08-ui-spec.md §6.3.1, §6.5.1). Decides whether the
 * string reaches `shell.openPath` (local paths) or `shell.openExternal`
 * (http/https and any other registered protocol, e.g. `obsidian://`), or is
 * refused outright as unsafe to hand to the OS.
 *
 * Pure logic — unit-tested without Electron.
 */

import { fileURLToPath } from 'node:url';

/** Result of classifying a raw user-entered target string. */
export type OpenTarget =
  | { kind: 'path'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'refused'; reason: string };

/**
 * Schemes that must never reach the OS handler: they carry executable/script
 * payloads (`javascript:`, `data:`, `vbscript:`) or reference renderer-side
 * blobs (`blob:`) / browser-internal pages (`about:`).
 */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'blob', 'about']);

/**
 * Classifies a raw target:
 *  - Windows drive paths (`C:\…`, `C:/…`, also `C:rel`), UNC paths
 *    (`\\server\share`) and scheme-less strings → local path;
 *  - `file://` URLs → decoded to a local path;
 *  - everything else with a scheme ≥2 chars (`https:`, `obsidian:`, `mailto:`…)
 *    → external URL for the OS default handler;
 *  - blocked schemes and anything that fails to decode → refused with reason.
 */
export function classifyOpenTarget(raw: string): OpenTarget {
  const target = raw.trim();
  if (target === '') return { kind: 'refused', reason: 'Пустой адрес.' };
  if (/^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')) {
    return { kind: 'path', path: target };
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)?.[1]?.toLowerCase() ?? '';
  // A single-letter «scheme» is a drive letter without a separator (`C:docs`).
  if (scheme === '' || scheme.length === 1) {
    return { kind: 'path', path: target };
  }
  if (scheme === 'file') {
    try {
      return { kind: 'path', path: fileURLToPath(new URL(target)) };
    } catch {
      return { kind: 'refused', reason: 'Некорректный file://-адрес.' };
    }
  }
  if (BLOCKED_SCHEMES.has(scheme)) {
    return { kind: 'refused', reason: `Протокол «${scheme}:» не поддерживается.` };
  }
  return { kind: 'external', url: target };
}
