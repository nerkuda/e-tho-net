/**
 * DOM construction helpers for the vanilla renderer.
 *
 * Small wrappers over `document.createElement` that keep the UI code terse.
 * All text is assigned via `textContent` (never `innerHTML`) unless the caller
 * explicitly renders server-produced HTML (search snippets, comment bodies) —
 * those paths use {@link renderHtml} and are documented at call sites.
 */

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

/** Converts any thrown value into a readable Russian message. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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

/**
 * Placeholder for a value: replaces missing inputs with a default and avoids
 * `null`/`undefined` in typed code paths.
 */
export function orDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}
