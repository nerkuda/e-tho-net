/**
 * Navigation policy of the application window (ошибка 37458cbc, круг 2).
 *
 * The ETN window must never leave the application: the renderer shows user
 * content (comment markdown) that can contain links of any shape — absolute
 * `http(s)`, protocol-relative (`//example.com/x`), site-relative
 * (`relative.html`) — and plain left clicks on the ones the renderer's own
 * handler (`renderer/editor/external-link.ts`) cannot own (relative /
 * protocol-relative) would otherwise replace the whole UI with a remote page
 * or a `chrome-error://chromewebdata/` error page. Electron's sibling gate
 * `setWindowOpenHandler` covers new-window requests only, so this module backs
 * `webContents.on('will-navigate')` — the top-frame navigation gate.
 *
 * Pure logic (no Electron import) — unit-tested without a window; the guard
 * `tests/guard-window-navigation.test.ts` freezes the rule.
 */

/**
 * Schemes the OS browser may open on our behalf — ЕДИНЫЙ ИСТОЧНИК для обоих
 * гейтов клиента: `will-navigate` (top-frame переход, эта политика) и
 * `setWindowOpenHandler` (новая вкладка / средняя кнопка, `src/main/index.ts`).
 * Anything else is denied outright (no external handler): `etnimg:`/`etn:`/
 * `file:`/`data:`/`javascript:` must not reach the OS from a navigation attempt.
 *
 * Изменяя набор, правь ТОЛЬКО здесь: сторож
 * `tests/guard-window-navigation.test.ts` краснеет, если главный процесс
 * сравнивает схемы своим литералом вместо этого набора.
 */
export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/** Outcome of a navigation attempt by the page. */
export interface NavigationDecision {
  /** `true` — this is the application's own page; let the navigation happen. */
  allow: boolean;
  /** External address to hand to the OS browser, or `null` (nothing to open). */
  external: string | null;
}

/** File paths compare case-insensitively on Windows, exactly elsewhere. */
function sameFilePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Decides what to do with a top-frame navigation attempt to `target` from the
 * page currently at `current`.
 *
 * Allowed: the application itself — the same `file:` document (prod build) or
 * the same origin as the dev server document. Everything else is denied; an
 * `http`/`https`/`mailto` target is additionally returned as `external` so the
 * caller can open it in the system browser (keeping explicit links working).
 *
 * Fail-closed: an unparsable target is denied, and so is any target when the
 * current URL itself cannot be parsed — except the empty current URL (nothing
 * loaded yet), which is allowed so a main-process `loadURL` is never blocked.
 */
export function decideNavigation(
  target: string,
  current: string,
  platform: NodeJS.Platform = process.platform,
): NavigationDecision {
  const deny: NavigationDecision = { allow: false, external: null };
  if (current === '') return { allow: true, external: null };
  let from: URL;
  let to: URL;
  try {
    from = new URL(current);
    to = new URL(target);
  } catch {
    return deny;
  }
  if (to.protocol === from.protocol) {
    if (to.protocol === 'file:') {
      // Prod: the very same document. `host` distinguishes a drive/host form
      // (`file://c:/…`) from the plain path form.
      if (to.host === from.host && sameFilePath(to.pathname, from.pathname, platform)) {
        return { allow: true, external: null };
      }
    } else if (from.origin !== 'null' && to.origin === from.origin) {
      // Dev: the Vite dev server serves the application from its origin.
      return { allow: true, external: null };
    }
  }
  const scheme = to.protocol.replace(/:$/, '').toLowerCase();
  return EXTERNAL_SCHEMES.has(scheme) ? { allow: false, external: to.href } : deny;
}
