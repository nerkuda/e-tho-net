/**
 * Ctrl-hover content preview engine (task «Предпросмотр содержимого с
 * зажатым Ctrl», stages 1-2/3).
 *
 * A generic, reusable popup engine modelled after `lib/image-zoom.ts`: one
 * delegated set of `document`-level listeners, a `pointer-events: auto`
 * popup (unlike the image magnifier — this one must be scrollable and host
 * clickable links), content resolved lazily per "kind" via a small resolver
 * registry so new content types (search/pinned/selection rows — stage 3) can
 * register themselves without touching this file's core.
 *
 * Trigger elements declare what to show via `data-hp-*` attributes (set by
 * {@link markCommentPreview}/{@link markChronoPreview}/
 * {@link markAttachmentsPreview}/{@link markThoughtCommentPreview} for
 * indicators, and by {@link wireCommentLinksInDom} for links inside rendered
 * comment text — stage 2 — or by a future caller calling
 * {@link registerHoverPreviewResolver} + setting `data-hp-kind` itself). This
 * mirrors `image-zoom.ts`'s `data-zoom-thought`/`data-zoom-attachment`
 * convention.
 *
 * Open/close model (differs from `image-zoom.ts` on purpose, see the task's
 * acceptance criteria):
 *  - opening requires Ctrl held over a trigger for a short debounce pause
 *    (not instant — Ctrl+hover is also used for other gestures, e.g. the
 *    selection panel's Ctrl+click/hover, and an instant trigger would
 *    conflict with them);
 *  - once open, a popup no longer depends on Ctrl. Each open popup in the
 *    chain closes INDEPENDENTLY: a popup at depth `d` counts as "still
 *    hovered" while the cursor sits over its own element OR over any deeper
 *    popup opened from inside it (depth `d+1`, `d+2`, …) — so browsing a
 *    nested popup keeps every ancestor in the chain alive, but moving the
 *    cursor back onto an ancestor (or away entirely) schedules a close after
 *    300 ms for that popup and every popup deeper than it, cancelled by
 *    re-entering its own subtree before the timer fires. The depth-1 popup
 *    additionally stays alive while the cursor rests on the original root
 *    trigger element (the indicator/link that opened it). `Escape` closes
 *    only the topmost (deepest, last opened) popup, one press at a time —
 *    not the whole chain (карточка ошибки «Некорректное закрытие
 *    предпросмотров», ETN 420a1f7e). Ctrl inside an already-open popup only
 *    matters for opening the NEXT, nested level;
 *  - nesting is capped at {@link MAX_DEPTH} levels.
 *
 * NOTE on dependency direction: this module intentionally imports only from
 * `lib/*`, `state.ts`, shared types, `@etn/markdown` (constants only) and
 * `editor/wiki-link-resolver.ts` (which itself has no further renderer
 * dependencies). It must NOT import from `editor/markdown-field.ts`,
 * `editor/chrono-tab.ts` or `editor/attachments.ts` — those already import
 * `canvas/canvas.ts`, and `canvas.ts` imports this module to wire its
 * indicators; importing back from here would close a module cycle. A couple
 * of small pure helpers (`etnimgUrl`, attachment-thumb resolution, chrono
 * `shortText`) are therefore duplicated locally instead of imported. The
 * reverse edge is fine and used by stage 2: `editor/markdown-field.ts`
 * imports {@link wireCommentLinksInDom} from here to mark the links inside a
 * freshly rendered comment view.
 */

import type { Attachment, Comment } from '@etn/shared';
import {
  WIKI_LINK_CLASS,
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
  WIKI_LINK_TARGET_ATTR,
} from '@etn/markdown';

import { div, el, fmtDate, renderHtml, span } from './dom.js';
import { etn } from './etn.js';
import { resolveWikiLinksInDom, searchLegacyWikiTarget } from '../editor/wiki-link-resolver.js';
import { store } from '../state.js';

/** Pause before an open Ctrl+hover actually opens a popup, ms. Kept short but
 *  non-zero so it never fires on a passing cursor / other Ctrl+hover gestures. */
const OPEN_DEBOUNCE_MS = 200;
/** Grace delay before closing the whole chain once the cursor leaves it, ms
 *  (task requirement: exactly 0.3 s — gives time to move the cursor into the
 *  freshly opened popup). */
const CLOSE_DELAY_MS = 300;
/** Maximum nesting depth of chained popups (task requirement). */
const MAX_DEPTH = 5;
/** Cursor→popup gap, px (mirrors `image-zoom.ts`'s `POPUP_OFFSET`). */
const POPUP_OFFSET = 10;

/** Resolved preview content: a title for the popup head + a ready DOM body. */
export interface HoverPreviewContent {
  title: string;
  body: HTMLElement;
  /**
   * Overrides the popup's default `max-width` (420px, see `styles.css`),
   * in px. Used by content whose size must scale with a specific viewport
   * rather than the app window — e.g. the canvas ellipse neighbours list,
   * capped at 25% of the canvas viewport's width, which can exceed the
   * generic default on a wide window.
   */
  maxWidthPx?: number;
  /** Overrides `.hp-body`'s default `max-height` (min(420px, 60vh)), in px —
   *  same reasoning as {@link maxWidthPx} (70% of the canvas viewport). */
  maxHeightPx?: number;
}

/** Builds the preview content for one trigger element, or `null` to show nothing
 *  (e.g. "no permanent comment" — the popup must not open at all per spec). */
export type HoverPreviewResolver = (trigger: HTMLElement) => Promise<HoverPreviewContent | null>;

const resolvers = new Map<string, HoverPreviewResolver>();

/** Registers a content resolver for a `data-hp-kind` value. Exported so later
 *  stages (wiki-links, files, URLs, other networks) can plug in without
 *  editing this module. */
export function registerHoverPreviewResolver(kind: string, resolver: HoverPreviewResolver): void {
  resolvers.set(kind, resolver);
}

// ---------------------------------------------------------------------------
// Trigger marking helpers (used by canvas.ts / structures.ts / links.ts)
// ---------------------------------------------------------------------------

/** Owner kind accepted by the built-in resolvers. */
type HoverOwnerType = 'thought' | 'link';

function markTrigger(
  trigger: HTMLElement,
  kind: string,
  ownerType: HoverOwnerType,
  ownerId: string,
  title: string,
): void {
  trigger.dataset['hpKind'] = kind;
  trigger.dataset['hpOwnerType'] = ownerType;
  trigger.dataset['hpOwnerId'] = ownerId;
  trigger.dataset['hpTitle'] = title;
}

/** Marks an element as a Ctrl-hover trigger for a permanent comment preview
 *  (📝 indicator, and — once wired at a later stage — a thought/link row with
 *  no indicators of its own). Shows nothing when the owner has no permanent
 *  comment (checked lazily by the resolver, not here). */
export function markCommentPreview(
  trigger: HTMLElement,
  ownerType: HoverOwnerType,
  ownerId: string,
  title: string,
): void {
  markTrigger(trigger, 'comment', ownerType, ownerId, title);
}

/** Marks an element as a Ctrl-hover trigger for the chronology list (📅 indicator). */
export function markChronoPreview(
  trigger: HTMLElement,
  ownerType: HoverOwnerType,
  ownerId: string,
  title: string,
): void {
  markTrigger(trigger, 'chrono', ownerType, ownerId, title);
}

/** Marks an element as a Ctrl-hover trigger for the attachments list (📎 indicator). */
export function markAttachmentsPreview(
  trigger: HTMLElement,
  ownerType: HoverOwnerType,
  ownerId: string,
  title: string,
): void {
  markTrigger(trigger, 'attachments', ownerType, ownerId, title);
}

/**
 * Universal "show this thought's permanent comment" trigger — for a thought
 * icon/row with no indicators of its own (search results, pinned/history bar,
 * selection panel, links-tab, thought-picker). Not wired to any screen yet in
 * this stage (those lists are stage 3); exposed now so stage 3 only needs to
 * call it.
 */
export function markThoughtCommentPreview(trigger: HTMLElement, thoughtId: string, title: string): void {
  markCommentPreview(trigger, 'thought', thoughtId, title);
}

/**
 * Marks a canvas cloud's top/bottom ellipse as a Ctrl-hover trigger for its
 * incoming (`dir: 'parents'`, top ellipse) / outgoing (`dir: 'children'`,
 * bottom ellipse) neighbour list (task «Распространить предпросмотр с
 * зажатым Ctrl на эллипсы облачков мыслей»). The `neighbors` resolver itself
 * is registered by `canvas/canvas.ts` (via {@link registerHoverPreviewResolver})
 * rather than living here — it needs `applyCloudStyle`/`resolveCloudStyle`/
 * `applyThoughtIcon`, which live in `canvas.ts`, and `canvas.ts` already
 * imports this module (see the module doc comment on the dependency
 * direction) — importing back would close a module cycle.
 */
export function markNeighborsPreview(
  trigger: HTMLElement,
  thoughtId: string,
  dir: 'parents' | 'children',
  title: string,
): void {
  markTrigger(trigger, 'neighbors', 'thought', thoughtId, title);
  trigger.dataset['hpDir'] = dir;
}

// ---------------------------------------------------------------------------
// Built-in resolvers: permanent comment / chronology / attachments
// ---------------------------------------------------------------------------

function ownerParams(trigger: HTMLElement): { ownerType: HoverOwnerType; ownerId: string } | null {
  const ownerType = trigger.dataset['hpOwnerType'];
  const ownerId = trigger.dataset['hpOwnerId'];
  if (ownerId === undefined || (ownerType !== 'thought' && ownerType !== 'link')) return null;
  return { ownerType, ownerId };
}

/**
 * Absolute server file path → `etnimg://` URL. Duplicated from
 * `editor/markdown-field.ts` (see the module doc comment for why it is not
 * imported from there).
 */
function etnimgUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) => {
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg[0]!.toLowerCase();
    return encodeURIComponent(seg);
  });
  return `etnimg://${encoded.join('/')}`;
}

/** Permanent comment (📝): rendered exactly like the comment view mode. */
async function resolveCommentContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const owner = ownerParams(trigger);
  const networkId = store.state.networkId;
  if (owner === null || networkId === null) return null;
  let comments: Comment[];
  try {
    comments = await etn.comments.list(networkId, owner.ownerType, owner.ownerId);
  } catch {
    return null;
  }
  const permanent = comments.find((c) => c.kind === 'permanent');
  if (permanent === undefined || permanent.body_html.trim() === '') return null;
  const body = div('comment-view hp-comment-body');
  renderHtml(body, permanent.body_html);
  void resolveWikiLinksInDom(body, networkId);
  return { title: trigger.dataset['hpTitle'] ?? '—', body };
}

/** One-line preview of a comment body — duplicated from `chrono-tab.ts`'s
 *  `shortText` (see the module doc comment for why it is not imported). */
function shortText(markdown: string): string {
  const plain = markdown
    .replace(/[#*_>`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

/** Chronology (📅): title + С/По dates + a short text preview, newest first. */
async function resolveChronoContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const owner = ownerParams(trigger);
  const networkId = store.state.networkId;
  if (owner === null || networkId === null) return null;
  let comments: Comment[];
  try {
    comments = await etn.comments.list(networkId, owner.ownerType, owner.ownerId);
  } catch {
    return null;
  }
  const entries = comments
    .filter((c) => c.kind === 'chronological')
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  if (entries.length === 0) return null;
  const body = div('hp-chrono-list');
  for (const entry of entries) {
    const row = div('hp-chrono-item');
    row.append(el('div', 'hp-chrono-title', entry.title ?? '—'));
    row.append(
      el(
        'div',
        'hp-chrono-dates',
        `С ${fmtDate(entry.valid_from)} · По ${entry.valid_to === null ? '…' : fmtDate(entry.valid_to)}`,
      ),
    );
    const text = shortText(entry.body_md);
    if (text !== '') row.append(el('div', 'hp-chrono-text', text));
    body.append(row);
  }
  return { title: trigger.dataset['hpTitle'] ?? '—', body };
}

/** True for a server-stored image file attachment. */
function isImageAttachmentFile(a: Attachment): boolean {
  return a.kind === 'file' && (a.mime_type ?? '').startsWith('image/');
}

const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i;

/** An `<img>` preview falling back to a glyph when the source fails to load. */
function imgThumb(src: string, fallbackGlyph: string): HTMLElement {
  const img = el('img', 'attachment-thumb');
  img.src = src;
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(span(fallbackGlyph, 'attachment-thumb')));
  return img;
}

/** Compact preview thumbnail — same visual rules as `attachments.ts`'s
 *  `buildThumb` (duplicated locally, see the module doc comment). */
function attachmentThumb(a: Attachment): HTMLElement {
  if (isImageAttachmentFile(a) && a.file_path !== null) return imgThumb(etnimgUrl(a.file_path), '🖼');
  if (a.kind === 'url') {
    const url = a.url ?? '';
    if (IMAGE_URL_RE.test(url)) return imgThumb(url, '🔗');
    if (a.icon !== null) return imgThumb(a.icon, '🔗');
    return span('🔗', 'attachment-thumb');
  }
  return span('📄', 'attachment-thumb');
}

/** Attachments (📎): compact rows styled like `.attachment-item`. */
async function resolveAttachmentsContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const owner = ownerParams(trigger);
  const networkId = store.state.networkId;
  if (owner === null || networkId === null) return null;
  let attachments: Attachment[];
  try {
    attachments = await etn.attachments.list(networkId, owner.ownerType, owner.ownerId);
  } catch {
    return null;
  }
  if (attachments.length === 0) return null;
  const body = div('hp-attachments-list');
  for (const a of attachments) {
    const row = div('attachment-item hp-attachment-item');
    row.append(attachmentThumb(a));
    const info = div('attachment-info');
    info.append(el('div', 'att-title', a.title ?? a.url ?? a.file_path ?? '—'));
    const meta =
      a.kind === 'url'
        ? (a.url ?? '')
        : `${a.file_path ?? ''}${a.file_size !== null ? ` · ${a.file_size} Б` : ''}`;
    info.append(el('div', 'att-meta', meta));
    row.append(info);
    body.append(row);
  }
  return { title: trigger.dataset['hpTitle'] ?? '—', body };
}

registerHoverPreviewResolver('comment', resolveCommentContent);
registerHoverPreviewResolver('chrono', resolveChronoContent);
registerHoverPreviewResolver('attachments', resolveAttachmentsContent);

// ---------------------------------------------------------------------------
// Stage 2/3: links inside rendered comment text (view mode).
//
// `wireCommentLinksInDom` is the single marking pass reused everywhere a
// server-rendered comment body lands in the DOM — the top-level comment view
// (`editor/markdown-field.ts`'s `renderView`) and every nested popup built by
// this module itself (the permanent-comment preview; file-text preview
// content has no links so it needs no wiring). It must run on the SAME
// element `resolveWikiLinksInDom` was called on, in either order — the wiki
// resolvers below re-check the live `wiki-link-deleted` class at hover time
// (after the ~200ms open debounce, well past the resolver's async paint),
// not at marking time, so marking never needs to wait for that promise.
// ---------------------------------------------------------------------------

/** Marks every hoverable link inside a rendered comment body with the right
 *  `data-hp-kind` — `.wiki-link[data-wiki-id]` (same/other network), legacy
 *  name-only `.wiki-link[data-wiki-target]` (no stable id — the target is
 *  resolved by name at hover time) and plain `<a href>` (file/URL). Any `<a>`
 *  that wraps an `<img>` (its own Ctrl-hover belongs to `image-zoom.ts`, see
 *  the module doc comment) is left unmarked — Ctrl+hover over it does nothing.
 *  Safe to call repeatedly; idempotent (just (re)writes attributes). */
export function wireCommentLinksInDom(root: HTMLElement): void {
  const wikiLinks = root.querySelectorAll<HTMLElement>(`span.${WIKI_LINK_CLASS}[${WIKI_LINK_ID_ATTR}]`);
  for (const span of wikiLinks) {
    const id = span.getAttribute(WIKI_LINK_ID_ATTR);
    if (id === null || id === '') continue;
    span.dataset['hpKind'] = span.hasAttribute(WIKI_LINK_NETWORK_ATTR) ? 'wiki-cross-network' : 'wiki-thought';
  }
  // Legacy name form (`[[Имя мысли|текст]]` → `data-wiki-target`, no
  // `data-wiki-id`): marked with its own kind — the resolver re-resolves the
  // name at hover time (names may change after the HTML is cached, so nothing
  // is baked in here).
  const legacyLinks = root.querySelectorAll<HTMLElement>(
    `span.${WIKI_LINK_CLASS}:not([${WIKI_LINK_ID_ATTR}])`,
  );
  for (const span of legacyLinks) {
    const name = span.getAttribute(WIKI_LINK_TARGET_ATTR);
    if (name === null || name === '') continue;
    span.dataset['hpKind'] = 'wiki-legacy-name';
  }
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const a of anchors) {
    if (a.classList.contains(WIKI_LINK_CLASS)) continue; // handled above
    if (a.querySelector('img') !== null) continue; // let image-zoom own it
    a.dataset['hpKind'] = 'link';
  }
}

/** Wiki-link to a thought of the SAME network (`.wiki-link[data-wiki-id]`
 *  without `data-wiki-network`): shows the target's permanent comment. The
 *  target is re-checked live (not from a value baked in at marking time) —
 *  missing/deleted/inaccessible (the `wiki-link-deleted` class painted by
 *  `resolveWikiLinksInDom`, or a failed lookup for any other reason) → `null`
 *  per spec ("мысль отсутствует — ничего не показывать"). */
async function resolveWikiThoughtContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  if (trigger.classList.contains('wiki-link-deleted')) return null;
  const thoughtId = trigger.getAttribute(WIKI_LINK_ID_ATTR);
  const networkId = store.state.networkId;
  if (thoughtId === null || thoughtId === '' || networkId === null) return null;
  let comments: Comment[];
  try {
    comments = await etn.comments.list(networkId, 'thought', thoughtId);
  } catch {
    return null;
  }
  const permanent = comments.find((c) => c.kind === 'permanent');
  if (permanent === undefined || permanent.body_html.trim() === '') return null;
  const body = div('comment-view hp-comment-body');
  renderHtml(body, permanent.body_html);
  wireCommentLinksInDom(body);
  void resolveWikiLinksInDom(body, networkId);
  const label = trigger.textContent?.trim();
  return { title: label !== undefined && label !== '' ? label : '—', body };
}

/** Legacy name-only wiki-link (`[[Имя мысли|текст]]`, rendered as
 *  `.wiki-link[data-wiki-target]` without `data-wiki-id`): resolves the target
 *  by name with the SAME lookup the navigation handler uses
 *  (`searchLegacyWikiTarget` in `editor/wiki-link-resolver.ts` — exact title
 *  match, else the first name hit; the lookup itself lives in that module
 *  precisely so this one does not have to import `editor/wiki-link.ts`, see
 *  the module doc comment) and previews the found thought's permanent comment,
 *  so what the preview shows is exactly what a click would open. Not found /
 *  lookup failed → `null`, no popup (same as a `wiki-link-deleted` id-link).
 *  The heading names the FOUND thought, uniform with alias-less id-links
 *  whose visible text is the resolved title (an aliased `[[#<id>|алиас]]`
 *  shows the alias); the link's own label is only the fallback when the hit
 *  carries no title. */
async function resolveWikiLegacyNameContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const name = trigger.getAttribute(WIKI_LINK_TARGET_ATTR);
  const networkId = store.state.networkId;
  if (name === null || name === '' || networkId === null) return null;
  let thoughtId: string;
  let foundTitle: string;
  try {
    const hit = await searchLegacyWikiTarget(networkId, name);
    if (hit === null) return null;
    thoughtId = hit.thoughtId;
    foundTitle = hit.title;
  } catch {
    return null;
  }
  let comments: Comment[];
  try {
    comments = await etn.comments.list(networkId, 'thought', thoughtId);
  } catch {
    return null;
  }
  const permanent = comments.find((c) => c.kind === 'permanent');
  if (permanent === undefined || permanent.body_html.trim() === '') return null;
  const body = div('comment-view hp-comment-body');
  renderHtml(body, permanent.body_html);
  wireCommentLinksInDom(body);
  void resolveWikiLinksInDom(body, networkId);
  const label = trigger.textContent?.trim();
  return { title: foundTitle !== '' ? foundTitle : (label ?? '—'), body };
}

/** Wiki-link to a thought in ANOTHER network (`[[n:<net>#<id>]]`): shows only
 *  a badge with that network's name — no content is fetched, and (per spec)
 *  the target network's own accessibility is not checked here (the user's
 *  problem when they click through). Falls back to the raw network id when
 *  the name cannot be resolved (no access / offline — the documented edge
 *  case). */
async function resolveWikiCrossNetworkContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const netId = trigger.getAttribute(WIKI_LINK_NETWORK_ATTR);
  if (netId === null || netId === '') return null;
  let displayName = store.state.networkList.find((n) => n.id === netId)?.display_name;
  if (displayName === undefined) {
    try {
      const list = await etn.networks.list();
      store.update({ networkList: list });
      displayName = list.find((n) => n.id === netId)?.display_name;
    } catch {
      displayName = undefined;
    }
  }
  const name = displayName ?? netId;
  const body = div('hp-network-badge');
  body.append(el('div', 'hp-network-name', `🌐 ${name}`));
  const label = trigger.textContent?.trim();
  return { title: label !== undefined && label !== '' ? label : name, body };
}

/** Content-types treated as text for a file preview, on top of the byte sniff
 *  in {@link looksLikeText} below (case-insensitive substring match against
 *  the response's `Content-Type`). */
const TEXT_CONTENT_TYPE_RE = /^text\/|json|xml|javascript|csv|yaml/i;

/** Cap on how much of a previewed file's text is shown (chars). */
const FILE_TEXT_PREVIEW_LIMIT = 20_000;

/** Basename of an `etnimg://` (or any) URL's path, decoded — the "full file
 *  name" the spec asks for in the fallback popup. Falls back to the raw href
 *  when the URL cannot be parsed. */
function fileNameFromUrl(href: string): string {
  try {
    const segments = decodeURIComponent(new URL(href).pathname)
      .split('/')
      .filter((s) => s !== '');
    return segments.length > 0 ? segments[segments.length - 1]! : href;
  } catch {
    return href;
  }
}

/** Cheap text/binary sniff over the first bytes of a fetched file: a NUL byte
 *  anywhere marks it binary; otherwise it's text when almost every byte is
 *  printable ASCII, a common control char, or part of a UTF-8 multibyte
 *  sequence (`>= 0x80`). Used only when the `Content-Type` header itself is
 *  missing/generic (`application/octet-stream`) — the etnimg protocol only
 *  special-cases a handful of extensions (main/index.ts's `ETNIMG_TYPES`),
 *  so this is what actually covers "код, markdown, json, csv... по эвристике
 *  текстовый/бинарный, не жёсткий список расширений" for everything else. */
function looksLikeText(buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf.slice(0, 4096));
  if (bytes.length === 0) return true;
  let printable = 0;
  for (const b of bytes) {
    if (b === 0) return false;
    if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13 || b >= 0x80) printable++;
  }
  return printable / bytes.length > 0.95;
}

/** Full-size `<img>` for a file preview (unlike the small `imgThumb` glyph-
 *  fallback used for attachment rows — a broken image here just shows the
 *  browser's default broken-image icon, acceptable for a best-effort preview). */
function fileImagePreview(src: string): HTMLElement {
  const img = el('img', 'hp-file-image');
  img.src = src;
  img.alt = '';
  return img;
}

/** Popup showing only the file's name — the "иначе" branch for a file link
 *  whose content is not an image/text (binary, unreadable, or the fetch
 *  itself failed). */
function fileNameFallback(filename: string): HoverPreviewContent {
  const body = div('hp-file-fallback');
  body.append(el('div', 'hp-file-name', filename));
  return { title: filename, body };
}

/** Local attachment file link (`href` starting with `etnimg:`): images show
 *  inline, text-ish content shows as a scrollable `<pre>` (truncated), any
 *  other content falls back to the filename-only popup. The `etnimg` protocol
 *  is local-only (served by the Electron main process straight off disk / the
 *  active connection's own REST API for remote-server attachments, see
 *  `client/src/main/index.ts`'s `registerEtnimgProtocol`) — unlike a remote
 *  URL this fetch never leaves the app's own trust boundary. */
async function resolveFileLinkContent(href: string): Promise<HoverPreviewContent> {
  const filename = fileNameFromUrl(href);
  if (IMAGE_URL_RE.test(href)) {
    const body = div('hp-file-preview');
    body.append(fileImagePreview(href));
    return { title: filename, body };
  }
  let resp: Response;
  try {
    resp = await fetch(href);
    if (!resp.ok) throw new Error(String(resp.status));
  } catch {
    return fileNameFallback(filename);
  }
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    const body = div('hp-file-preview');
    body.append(fileImagePreview(href));
    return { title: filename, body };
  }
  let buf: ArrayBuffer;
  try {
    buf = await resp.arrayBuffer();
  } catch {
    return fileNameFallback(filename);
  }
  const generic = contentType === '' || contentType === 'application/octet-stream';
  const isText = TEXT_CONTENT_TYPE_RE.test(contentType) || (generic && looksLikeText(buf));
  if (!isText) return fileNameFallback(filename);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const truncated = text.length > FILE_TEXT_PREVIEW_LIMIT;
  const body = div('hp-file-preview');
  body.append(
    el('pre', 'hp-file-text', truncated ? `${text.slice(0, FILE_TEXT_PREVIEW_LIMIT)}\n…` : text),
  );
  return { title: filename, body };
}

/** Any plain `<a href>` in comment text that is not a wiki-link: a local
 *  attachment file (`etnimg:` — case "ссылка на файл") gets its content
 *  previewed via {@link resolveFileLinkContent}; every other URL (http(s),
 *  mailto, …) is the "прочий URL" case — its content is never fetched, the
 *  popup just shows the full URL text per spec. */
async function resolveLinkContent(trigger: HTMLElement): Promise<HoverPreviewContent | null> {
  const href = trigger.getAttribute('href');
  if (href === null || href === '') return null;
  if (/^etnimg:/i.test(href)) return resolveFileLinkContent(href);
  const body = div('hp-url-body');
  body.append(el('div', 'hp-url-text', href));
  const label = trigger.textContent?.trim();
  return { title: label !== undefined && label !== '' ? label : href, body };
}

registerHoverPreviewResolver('wiki-thought', resolveWikiThoughtContent);
registerHoverPreviewResolver('wiki-legacy-name', resolveWikiLegacyNameContent);
registerHoverPreviewResolver('wiki-cross-network', resolveWikiCrossNetworkContent);
registerHoverPreviewResolver('link', resolveLinkContent);

// ---------------------------------------------------------------------------
// Engine: open chain, positioning, event delegation
// ---------------------------------------------------------------------------

interface ChainEntry {
  depth: number;
  el: HTMLElement;
  triggerEl: HTMLElement;
  /** Per-entry close timer (task fix, ETN 420a1f7e) — each popup closes on its
   *  own schedule instead of sharing one timer for the whole chain. */
  closeTimer: number | null;
}

/** Structural subset of `HTMLElement`/`Node` used by {@link isChainEntryAlive}
 *  so the aliveness decision stays pure and testable without a real DOM. */
interface ContainerLike {
  contains(node: Node | null): boolean;
}

/** Trigger element of depth-1 popup (lives outside any popup, on the host
 *  screen — a cloud indicator, a link popover span, …). */
let rootTrigger: HTMLElement | null = null;
/** Open popups, depth 1..N, in order. */
let chain: ChainEntry[] = [];
let pendingOpen: { candidate: HTMLElement; timer: number } | null = null;
/** Bumped on every settled `doOpen` — cancels a stale in-flight fetch whose
 *  result would otherwise apply after the user moved on. */
let openGeneration = 0;
let mouseX = 0;
let mouseY = 0;

function cancelPendingOpen(): void {
  if (pendingOpen !== null) {
    window.clearTimeout(pendingOpen.timer);
    pendingOpen = null;
  }
}

function cancelEntryCloseTimer(entry: ChainEntry): void {
  if (entry.closeTimer !== null) {
    window.clearTimeout(entry.closeTimer);
    entry.closeTimer = null;
  }
}

/** Schedules `entry`'s own close after {@link CLOSE_DELAY_MS} (a no-op while
 *  one is already pending for it). Fires `closeEntryAndDeeper` for the
 *  entry's CURRENT index at fire time (re-read via `indexOf`, since entries
 *  shallower than it may have already closed and shifted nothing — indices
 *  are stable as long as the entry itself is still in `chain`). */
function scheduleEntryClose(entry: ChainEntry): void {
  if (entry.closeTimer !== null) return;
  entry.closeTimer = window.setTimeout(() => {
    entry.closeTimer = null;
    const idx = chain.indexOf(entry);
    if (idx === -1) return; // already removed by a full close / truncate / Esc
    closeEntryAndDeeper(idx);
  }, CLOSE_DELAY_MS);
}

/**
 * True when `node` should keep the chain entry at `index` alive: the cursor
 * sits over that entry's own element, or over any DEEPER entry (`index + 1`,
 * `index + 2`, …) — browsing a nested popup keeps every ancestor popup in the
 * chain from closing. `index === 0` additionally counts the root trigger
 * itself (the page element that opened the first popup). Pure and DOM-free
 * beyond the structural `contains` check, so it can be unit-tested with
 * plain mock containers (see `hoverPreviewInternals.isChainEntryAlive`).
 */
function isChainEntryAlive(
  entries: readonly { el: ContainerLike }[],
  index: number,
  root: ContainerLike | null,
  node: Node | null,
): boolean {
  if (index === 0 && root !== null && root.contains(node)) return true;
  for (let j = index; j < entries.length; j++) {
    if (entries[j]!.el.contains(node)) return true;
  }
  return false;
}

/** True when `node` lies inside the root trigger or any currently open popup
 *  of the chain — used only to tell "a scroll happened somewhere inside our
 *  own UI" (see the `scroll` listener) from "a scroll happened elsewhere on
 *  the page", which still closes everything. NOT used for the per-entry
 *  independent-close decision any more — see {@link isChainEntryAlive}. */
function withinIsland(node: Node | null): boolean {
  if (node === null) return false;
  if (rootTrigger !== null && rootTrigger.contains(node)) return true;
  for (const entry of chain) {
    if (entry.el.contains(node)) return true;
  }
  return false;
}

function closeChain(): void {
  for (const entry of chain) {
    cancelEntryCloseTimer(entry);
    entry.el.remove();
  }
  chain = [];
  rootTrigger = null;
}

/**
 * Closes the whole open popup chain on demand. Used by a row rendered inside
 * a popup that navigates away on click (e.g. the neighbours-preview list —
 * "open in editor" / "focus") — the popup must not linger once its content is
 * no longer what the cursor is over.
 */
export function closeHoverPreview(): void {
  cancelPendingOpen();
  closeChain();
}

/** Closes the chain entry at `index` together with every entry deeper than it
 *  (a deeper popup can never legitimately outlive the popup it was opened
 *  from — see {@link isChainEntryAlive}). Resets `rootTrigger` once the whole
 *  chain has emptied out. Used both by a fired per-entry close timer and by
 *  `Escape` (closing just the topmost entry, i.e. `index = chain.length - 1`). */
function closeEntryAndDeeper(index: number): void {
  while (chain.length > index) {
    const entry = chain.pop()!;
    cancelEntryCloseTimer(entry);
    entry.el.remove();
  }
  if (chain.length === 0) rootTrigger = null;
}

/** Drops every open popup deeper than `maxDepth` (a new nested open replaces
 *  whatever nested chain was open before it, like re-hovering a sibling link). */
function truncateChainTo(maxDepth: number): void {
  while (chain.length > 0 && chain[chain.length - 1]!.depth > maxDepth) {
    const entry = chain.pop()!;
    cancelEntryCloseTimer(entry);
    entry.el.remove();
  }
}

/** The depth a popup opened from `candidate` would have: 1 for a trigger
 *  outside any open popup, deepest-containing-popup depth + 1 otherwise. */
function depthFor(candidate: HTMLElement): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i]!.el.contains(candidate)) return chain[i]!.depth + 1;
  }
  return 1;
}

function isAlreadyOpenAt(candidate: HTMLElement, depth: number): boolean {
  if (depth === 1) return rootTrigger === candidate;
  return chain.some((e) => e.depth === depth && e.triggerEl === candidate);
}

function buildPopupEl(content: HoverPreviewContent, depth: number): HTMLElement {
  const popup = div('hover-preview-popup');
  popup.dataset['depth'] = String(depth);
  if (content.maxWidthPx !== undefined) popup.style.maxWidth = `${content.maxWidthPx}px`;
  const bodyWrap = div('hp-body');
  if (content.maxHeightPx !== undefined) bodyWrap.style.maxHeight = `${content.maxHeightPx}px`;
  bodyWrap.append(content.body);
  popup.append(el('div', 'hp-head', content.title), bodyWrap);
  return popup;
}

/** Places the popup near the trigger, flipping above it when there is no room
 *  below, and clamping horizontally to the viewport — the same auto-adjust
 *  idea as `image-zoom.ts`'s `place()`. A CSS arrow (`--hp-arrow-left` + the
 *  `data-arrow` side) keeps the visual link to the trigger even after the
 *  clamp shifts the box sideways. */
function positionPopup(popup: HTMLElement, trigger: HTMLElement): void {
  const triggerRect = trigger.getBoundingClientRect();
  const anchorX = triggerRect.left + triggerRect.width / 2;
  const rect = popup.getBoundingClientRect();

  let left = anchorX - rect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));

  let top = triggerRect.bottom + POPUP_OFFSET;
  let arrowSide: 'top' | 'bottom' = 'top';
  if (top + rect.height > window.innerHeight - 8) {
    const above = triggerRect.top - POPUP_OFFSET - rect.height;
    if (above >= 8) {
      top = above;
      arrowSide = 'bottom';
    } else {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
  }

  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
  popup.dataset['arrow'] = arrowSide;
  const arrowLeft = Math.max(14, Math.min(rect.width - 14, anchorX - left));
  popup.style.setProperty('--hp-arrow-left', `${Math.round(arrowLeft)}px`);
}

async function doOpen(candidate: HTMLElement, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const kind = candidate.dataset['hpKind'];
  if (kind === undefined) return;
  const resolver = resolvers.get(kind);
  if (resolver === undefined) return;

  const gen = ++openGeneration;
  let content: HoverPreviewContent | null;
  try {
    content = await resolver(candidate);
  } catch {
    content = null;
  }
  if (gen !== openGeneration) return; // superseded by a newer open/close
  if (content === null) return; // e.g. no permanent comment — show nothing

  if (depth === 1) {
    closeChain();
    rootTrigger = candidate;
  } else {
    truncateChainTo(depth - 1);
  }
  const popupEl = buildPopupEl(content, depth);
  document.body.append(popupEl);
  positionPopup(popupEl, candidate);
  chain.push({ depth, el: popupEl, triggerEl: candidate, closeTimer: null });
}

function tryScheduleOpen(candidate: HTMLElement): void {
  if (candidate.dataset['hpKind'] === undefined) return;
  const depth = depthFor(candidate);
  if (depth > MAX_DEPTH || isAlreadyOpenAt(candidate, depth)) return;
  if (pendingOpen !== null && pendingOpen.candidate === candidate) return;
  cancelPendingOpen();
  const timer = window.setTimeout(() => {
    pendingOpen = null;
    void doOpen(candidate, depth);
  }, OPEN_DEBOUNCE_MS);
  pendingOpen = { candidate, timer };
}

let initialized = false;

/** Installs the document-level hover-preview engine (idempotent; called once
 *  from boot, alongside `initImageZoom`). */
export function initHoverPreview(): void {
  if (initialized) return;
  initialized = true;

  document.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    const target = event.target instanceof Element ? event.target : null;

    // Each open popup decides independently whether it is still "hovered"
    // (task fix, ETN 420a1f7e): a shallower popup stays alive while the
    // cursor sits over ANY deeper popup opened from inside it, but moving the
    // cursor back onto it (or away entirely) starts ITS OWN close timer —
    // it no longer waits for every popup in the chain to be left at once.
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i]!;
      if (isChainEntryAlive(chain, i, rootTrigger, target)) cancelEntryCloseTimer(entry);
      else scheduleEntryClose(entry);
    }

    if (!event.ctrlKey) {
      cancelPendingOpen();
      return;
    }
    const candidate = target?.closest<HTMLElement>('[data-hp-kind]') ?? null;
    if (candidate === null) {
      cancelPendingOpen();
      return;
    }
    tryScheduleOpen(candidate);
  });

  // Ctrl pressed while the cursor is already resting on a trigger (mirrors
  // `image-zoom.ts`'s keydown handling — no mousemove fires in that case).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // Closes only the topmost (deepest, last opened) popup, one Esc press
      // at a time — not the whole chain (task fix, ETN 420a1f7e).
      cancelPendingOpen();
      if (chain.length > 0) closeEntryAndDeeper(chain.length - 1);
      return;
    }
    if (event.key !== 'Control') return;
    const at = document.elementFromPoint(mouseX, mouseY);
    const candidate = at instanceof Element ? at.closest<HTMLElement>('[data-hp-kind]') : null;
    if (candidate !== null) tryScheduleOpen(candidate);
  });
  document.addEventListener('keyup', (event) => {
    // Releasing Ctrl only cancels a not-yet-opened popup (the debounce is
    // still pending) — an already-open chain is unaffected (task spec).
    if (event.key === 'Control') cancelPendingOpen();
  });

  // A scroll elsewhere on the page (canvas pan, a zone/tree scrolling) leaves
  // an anchored popup visually detached from its trigger — close the chain.
  // Scrolling INSIDE one of our own popups (`.hp-body`, `.comment-view`) must
  // not trigger this — capture-phase `scroll` fires for that target too, so
  // it is explicitly excluded via `withinIsland`.
  document.addEventListener(
    'scroll',
    (event) => {
      if (chain.length === 0) return;
      const target = event.target;
      if (target instanceof Node && withinIsland(target)) return;
      closeChain();
    },
    true,
  );
  window.addEventListener('blur', () => {
    closeChain();
    cancelPendingOpen();
  });
}

/** Test seam. */
export const hoverPreviewInternals = {
  depthFor,
  isAlreadyOpenAt,
  isChainEntryAlive,
  MAX_DEPTH,
  OPEN_DEBOUNCE_MS,
  CLOSE_DELAY_MS,
  fileNameFromUrl,
  looksLikeText,
};
