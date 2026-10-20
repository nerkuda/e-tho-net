/**
 * DOM construction helpers for the vanilla renderer.
 *
 * Small wrappers over `document.createElement` that keep the UI code terse.
 * All text is assigned via `textContent` (never `innerHTML`) unless the caller
 * explicitly renders server-produced HTML (search snippets, comment bodies) —
 * those paths use {@link renderHtml} and are documented at call sites.
 */

import { t } from './i18n.js';
import { splitHighlightRuns } from './pure.js';

/** Creates an element with an optional class and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Creates a `<div>` with an optional class. */
export function div(className?: string): HTMLDivElement {
  return el('div', className);
}

/** Creates a `<span>` with text and an optional class. */
export function span(text: string, className?: string): HTMLSpanElement {
  return el('span', className, text);
}

/** Creates a `<button>` with a click handler, optional class and tooltip. */
export function button(
  label: string,
  onClick: () => void,
  className?: string,
  title?: string,
): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  if (title !== undefined) node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

/** Removes every child of a node. */
export function clear(node: HTMLElement): void {
  while (node.firstChild !== null) {
    node.removeChild(node.firstChild);
  }
}

/**
 * Renders server-produced HTML (sanitised on the server: XSS-free markdown
 * renderer, `<mark>` snippets) into a node. Only call with trusted server HTML.
 */
export function renderHtml(node: HTMLElement, html: string): void {
  node.innerHTML = html;
}

/** Sets the native tooltip (full text shown on hover). */
export function setTooltip(node: HTMLElement, text: string): void {
  node.title = text;
}

/**
 * Рисует текст с подсветкой совпадений: отрезки, попавшие в термы
 * ({@link splitHighlightRuns}), оборачиваются в `<mark>` — тем же видом, что
 * серверные сниппеты поиска, — остальное идёт текстовыми узлами. Термов нет
 * (или совпадений нет) — обычный текст; `innerHTML` не используется.
 */
export function renderHighlightedText(
  node: HTMLElement,
  text: string,
  terms: readonly string[],
): void {
  const runs = splitHighlightRuns(text, terms);
  if (!runs.some((run) => run.hit)) {
    // Совпадений нет — текст как есть, без разметки (и без лишних узлов).
    node.textContent = text;
    return;
  }
  node.replaceChildren();
  for (const run of runs) {
    if (run.hit) {
      node.append(el('mark', undefined, run.text));
    } else {
      node.append(document.createTextNode(run.text));
    }
  }
}

/** Structural view of an error carrying the main-process wire fields. */
interface ErrorLike {
  code?: unknown;
  details?: unknown;
  message?: unknown;
  name?: unknown;
}

function asErrorLike(err: unknown): ErrorLike | null {
  if (typeof err === 'object' && err !== null) return err as ErrorLike;
  return null;
}

/**
 * `true` when the failure is OUR link-down rejection (main-process gate or a
 * cancelled REST request, defect de34b35b). The main process marks both with
 * `details.kind === 'connection-lost'`; the renderer receives a revived
 * `EtnError`, but the check is structural so a plain IPC/replay object works
 * too.
 */
export function isConnectionLostError(err: unknown): boolean {
  const details = asErrorLike(err)?.details;
  if (typeof details !== 'object' || details === null) return false;
  return (details as { kind?: unknown }).kind === 'connection-lost';
}

/**
 * Raw transport failures that must never reach the user as-is (they name
 * `fetch`, sockets and abort codes). Matched against the message of an
 * `Error`; `AbortError` is also matched by name.
 */
const RAW_NETWORK_ERROR_RE =
  /fetch failed|failed to fetch|networkerror|econn(?:refused|reset|aborted)|etimedout|ehostunreach|enotfound|abort(?:ed)?|сетевая ошибка/i;

/**
 * Converts any thrown value into a readable Russian message (замечания
 * заказчика после проверки GUI: «Дружелюбные сообщения»).
 *
 * - `connection-lost` (`details.kind`) → «нет соединения с сервером»;
 * - `INTERNAL` and raw transport errors (`fetch failed`, `ECONN*`,
 *   `ETIMEDOUT`, `AbortError`, «Сетевая ошибка») → «сервер недоступен,
 *   попробуйте позже» — technical words, codes and stacks never leak;
 * - business errors (`VALIDATION_ERROR`, `DUPLICATE`, `LOCKED`,
 *   `VERSION_CONFLICT`, …) keep their server-authored message verbatim.
 */
export function errText(err: unknown): string {
  if (isConnectionLostError(err)) return t('errors.connectionLost');
  const like = asErrorLike(err);
  if (like?.code === 'INTERNAL') return t('errors.serverUnavailable');
  const message = err instanceof Error ? err.message : String(err);
  if (like?.name === 'AbortError' || RAW_NETWORK_ERROR_RE.test(message)) {
    return t('errors.serverUnavailable');
  }
  return message;
}

/** Formats an ISO date as `ДД.ММ.ГГГГ` (Russian locale). */
export function fmtDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU');
}

/** Formats an ISO timestamp as `ДД.ММ.ГГГГ, ЧЧ:ММ:СС`. */
export function fmtDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}

/** True when `text` looks like an http(s) URL. */
export function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/** The four font-style flags of a thought/thought-type (02-data-model.md §3.1.1). */
export interface FontFlags {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

/**
 * Applies font flags to a flat (non-canvas) element via inline styles. The
 * `font-bold`/… utility classes only exist scoped to `.cloud … .cloud-title`
 * (styles.css), so type lists and combobox rows must style themselves inline —
 * exactly like their colours do.
 */
export function applyFontFlags(target: HTMLElement, flags: FontFlags): void {
  target.style.fontWeight = flags.bold ? 'bold' : '';
  target.style.fontStyle = flags.italic ? 'italic' : '';
  target.style.textDecorationLine =
    flags.underline && flags.strike
      ? 'underline line-through'
      : flags.underline
        ? 'underline'
        : flags.strike
          ? 'line-through'
          : '';
}

/**
 * Placeholder for a value: replaces missing inputs with a default and avoids
 * `null`/`undefined` in typed code paths.
 */
export function orDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

/**
 * Minimal selection shape {@link hasTextSelection} reads — a structural
 * subset of DOM `Selection` so the predicate stays unit-testable under Node
 * (the same trick as `ShortcutEventLike` in lib/dialog.ts).
 */
export interface TextSelectionLike {
  rangeCount: number;
  isCollapsed: boolean;
  toString(): string;
  getRangeAt(index: number): { getClientRects(): { length: number } };
}

/**
 * True when the selection is a real, visible DOM text selection that the
 * native Ctrl+C must honour instead of the global thought-copy handler
 * (error b6690109): non-collapsed, non-whitespace text inside *rendered*
 * content — e.g. text selected in a comment's view mode (`.comment-view`),
 * which is not an editable surface.
 *
 * The client-rects check drops phantom selections: a range can survive in
 * DOM that is no longer rendered (e.g. the hidden CM6 subtree after a
 * markdown field returns to view mode). Such a selection has no rects and
 * must not block the thought copy.
 */
export function hasTextSelection(selection: TextSelectionLike | null): boolean {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (selection.toString().trim() === '') return false;
  return selection.getRangeAt(0).getClientRects().length > 0;
}

/**
 * Places a body-mounted, fixed-position dropdown under `anchor`, flipping up
 * when the bottom screen edge interferes — the shared placement of the
 * property-value pickers (08-ui-spec.md §6.3). The list is never narrower than
 * the anchor and never wider than `maxWidth`. `minWidth` поднимает нижнюю
 * границу ширины (поле «Свойство связи» просит список заметно шире узкого
 * поля ввода — имена сторон и пары не помещались, ошибка 5817b009).
 */
export function positionBodyDropdown(
  list: HTMLElement,
  anchor: HTMLElement,
  maxWidth = 320,
  minWidth = 0,
): void {
  if (minWidth > 0) list.style.minWidth = `${minWidth}px`;
  const rect = anchor.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  const cap = Math.max(maxWidth, minWidth);
  const width = Math.max(rect.width, minWidth, Math.min(listRect.width, cap));
  const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
  let top = rect.bottom + 2;
  if (top + listRect.height > window.innerHeight - 6 && rect.top > listRect.height + 6) {
    top = Math.max(6, rect.top - listRect.height - 2);
  }
  list.style.left = `${Math.round(left)}px`;
  list.style.top = `${Math.round(top)}px`;
  list.style.width = `${Math.round(width)}px`;
}
