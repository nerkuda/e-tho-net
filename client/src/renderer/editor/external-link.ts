/**
 * Click handling for EXTERNAL links (`http:`, `https:`, `mailto:`) in rendered
 * comment/view HTML (ошибка 37458cbc).
 *
 * The single renderer (@etn/markdown) emits real `<a href>` anchors for
 * explicit markdown links and, since the autorlink fix, for bare `https://…`
 * strings. Electron windows have no `will-navigate` guard, so a plain left
 * click on such an anchor would replace the whole ETN UI with the remote page
 * (the anchors carry no `target="_blank"`). This module installs a delegated
 * document-level click listener — the same pattern as `wiki-link.ts` /
 * `lib/etnimg-link.ts` — that intercepts external clicks, calls
 * `preventDefault()` and routes the open through `window.open(href, '_blank')`.
 *
 * Routing through `window.open` deliberately keeps the main process as the
 * single decision point: `setWindowOpenHandler` (`src/main/index.ts`)
 * classifies the target and opens exactly `http`/`https`/`mailto` in the OS
 * browser via `shell.openExternal`, denying everything else. No second copy of
 * the URL allow-list lives in the renderer.
 *
 * Deliberately NOT touched: `.wiki-link` (its own navigation handler), internal
 * transitions, and hash/relative anchors — a publication document's in-page
 * anchors (`#pub-…`) must keep working. Modified and middle clicks fall through
 * to the platform / `setWindowOpenHandler`, which already handles them.
 *
 * Known limit (reported, not fixed here): an explicit relative link
 * (`[x](foo)`) still has no navigation guard — only explicit external schemes
 * are intercepted.
 *
 * Pure helpers are exposed via {@link externalLinkInternals} for unit tests.
 */

/** Hrefs this module owns: explicit external schemes (autolinked URLs among them). */
const EXTERNAL_HREF_RE = /^(?:https?|mailto):/i;

/** True for an href the OS browser must open (see {@link EXTERNAL_HREF_RE}). */
function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF_RE.test(href);
}

let wired = false;

/** Installs the delegated external-link click handler (call once from main.ts). */
export function initExternalLinkNavigation(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (event) => {
    // Another handler already claimed the click (e.g. a wiki-link).
    if (event.defaultPrevented) return;
    // Only a plain left click: middle-click / Ctrl-click / Shift-click must
    // keep going to `setWindowOpenHandler`, the platform's own new-window path.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.classList.contains('wiki-link')) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!isExternalHref(href)) return;
    // Never let the app window navigate to the external page.
    event.preventDefault();
    // `_blank` reaches the main process's `setWindowOpenHandler`, which opens
    // http/https/mailto in the system browser and denies everything else.
    window.open(href, '_blank', 'noopener');
  });
}

/** Test seam: pure helpers. */
export const externalLinkInternals = { isExternalHref };
