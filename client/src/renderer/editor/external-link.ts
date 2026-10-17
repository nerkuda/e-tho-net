/**
 * Click handling for EXTERNAL links (`http:`, `https:`, `mailto:`) in rendered
 * comment/view HTML (ошибка 37458cbc).
 *
 * The single renderer (@etn/markdown) emits real `<a href>` anchors for explicit
 * markdown links and, since the autolink fix, for bare `https://…` /
 * `mailto:…` strings. The anchors carry no `target="_blank"`, so a plain left
 * click on one would try to replace the whole ETN UI with the remote page. This
 * module installs a delegated document-level click listener — the same pattern
 * as `wiki-link.ts` / `lib/etnimg-link.ts` — that intercepts external clicks,
 * calls `preventDefault()` and routes the open through
 * `window.open(href, '_blank')`.
 *
 * Routing through `window.open` deliberately keeps the main process as the
 * single decision point: `setWindowOpenHandler` (`src/main/index.ts`)
 * classifies the target and opens exactly the schemes of
 * `EXTERNAL_SCHEMES` (`main/navigation-policy.ts`) in the OS browser via
 * `shell.openExternal`, denying everything else. The renderer cannot import
 * main-process code (separate bundles; the only bridge is `window.etn`), so the
 * same scheme set is mirrored here as an EXPLICIT copy —
 * {@link EXTERNAL_SCHEME_COPY} — and the copy is frozen by the guard
 * `tests/guard-window-navigation.test.ts`: it compares the copy with
 * `EXTERNAL_SCHEMES` and checks the predicate against both sets, so editing the
 * set in one place only turns that guard red.
 *
 * This handler is not the only line of defence: the main process ALSO gates
 * top-frame navigation (`will-navigate` + `main/navigation-policy.ts`), so the
 * window can never leave the application — whatever link shape the content
 * contains and whether or not this listener owns it (relative anchors, exotic
 * schemes, scripted `location` changes).
 *
 * A double click (the gesture that enters comment editing) must not open the
 * browser twice: the SECOND click of a multi-click is still prevented from
 * navigating but does not call `window.open` — the link opens exactly once.
 *
 * Deliberately NOT touched: `.wiki-link` (its own navigation handler), internal
 * transitions, and hash/relative anchors — a publication document's in-page
 * anchors (`#pub-…`) must keep working. Modified and middle clicks fall through
 * to the platform / `setWindowOpenHandler`, which already handles them.
 *
 * Known limit (reported, not fixed here): an explicit relative link
 * (`[x](foo)`) is not opened by this handler — the navigation is denied by the
 * main process's `will-navigate` gate, so the window simply stays put.
 *
 * Pure helpers are exposed via {@link externalLinkInternals} for unit tests.
 */

/**
 * ОСОЗНАННАЯ КОПИЯ набора внешних схем главного процесса (`main/navigation-policy.ts`
 * → `EXTERNAL_SCHEMES`). Рендерер не может импортировать код главного процесса
 * (разные бандлы, единственная связь — мост `window.etn`), поэтому список
 * повторён здесь ЯВНЫМ массивом, а не спрятан в регулярке: так его видно и
 * сверяет сторож `tests/guard-window-navigation.test.ts` (сравнивает массив с
 * `EXTERNAL_SCHEMES` и поведение предиката против обоих наборов). Правя набор,
 * правь ОБА места — расхождение в любую сторону краснит сторож.
 */
const EXTERNAL_SCHEME_COPY = ['http', 'https', 'mailto'] as const;

/** Hrefs this module owns: explicit external schemes (autolinked URLs among them). */
const EXTERNAL_HREF_RE = new RegExp(`^(?:${EXTERNAL_SCHEME_COPY.join('|')}):`, 'i');

/** True for an href the OS browser must open (see {@link EXTERNAL_HREF_RE}). */
function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF_RE.test(href);
}

/** The second (and later) click of a multi-click — see the module doc. */
function isRepeatedClick(detail: number): boolean {
  return detail > 1;
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
    // Never let the app window navigate to the external page — on ANY click of
    // the multi-click gesture.
    event.preventDefault();
    // ...but open it once: on a double click (which also enters editing) the
    // second call would spawn a duplicate tab in the system browser.
    if (isRepeatedClick(event.detail)) return;
    // `_blank` reaches the main process's `setWindowOpenHandler`, which opens
    // http/https/mailto in the system browser and denies everything else.
    window.open(href, '_blank', 'noopener');
  });
}

/** Test seam: pure helpers. */
export const externalLinkInternals = { isExternalHref, isRepeatedClick };
