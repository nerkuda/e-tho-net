/**
 * Ctrl-hover content preview engine (task «Предпросмотр содержимого с
 * зажатым Ctrl», stage 1/3).
 *
 * A generic, reusable popup engine modelled after `lib/image-zoom.ts`: one
 * delegated set of `document`-level listeners, a `pointer-events: auto`
 * popup (unlike the image magnifier — this one must be scrollable and host
 * clickable links), content resolved lazily per "kind" via a small resolver
 * registry so new content types (wiki-links, files, URLs — stage 2; search/
 * pinned/selection rows — stage 3) can register themselves without touching
 * this file's core.
 *
 * Trigger elements declare what to show via `data-hp-*` attributes (set by
 * {@link markCommentPreview}/{@link markChronoPreview}/
 * {@link markAttachmentsPreview}/{@link markThoughtCommentPreview}, or by a
 * future caller calling {@link registerHoverPreviewResolver} + setting
 * `data-hp-kind` itself). This mirrors `image-zoom.ts`'s
 * `data-zoom-thought`/`data-zoom-attachment` convention.
 *
 * Open/close model (differs from `image-zoom.ts` on purpose, see the task's
 * acceptance criteria):
 *  - opening requires Ctrl held over a trigger for a short debounce pause
 *    (not instant — Ctrl+hover is also used for other gestures, e.g. the
 *    selection panel's Ctrl+click/hover, and an instant trigger would
 *    conflict with them);
 *  - once open, a popup no longer depends on Ctrl. The whole open chain
 *    (root trigger + every nested popup opened from links/images inside it)
 *    behaves as one "hover island": leaving it schedules a close after
 *    300 ms (cancelled by re-entering any part of it before the timer
 *    fires); Ctrl inside an already-open popup only matters for opening the
 *    NEXT, nested level;
 *  - nesting is capped at {@link MAX_DEPTH} levels.
 *
 * NOTE on dependency direction: this module intentionally imports only from
 * `lib/*`, `state.ts`, shared types and `editor/wiki-link-resolver.ts` (which
 * itself has no further renderer dependencies). It must NOT import from
 * `editor/markdown-field.ts`, `editor/chrono-tab.ts` or
 * `editor/attachments.ts` — those already import `canvas/canvas.ts`, and
 * `canvas.ts` imports this module to wire its indicators; importing back
 * from here would close a module cycle. A couple of small pure helpers
 * (`etnimgUrl`, attachment-thumb resolution, chrono `shortText`) are
 * therefore duplicated locally instead of imported.
 */

import type { Attachment, Comment } from '@etn/shared';

import { div, el, fmtDate, renderHtml, span } from './dom.js';
import { etn } from './etn.js';
import { resolveWikiLinksInDom } from '../editor/wiki-link-resolver.js';
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
// Engine: open chain, positioning, event delegation
// ---------------------------------------------------------------------------

interface ChainEntry {
  depth: number;
  el: HTMLElement;
  triggerEl: HTMLElement;
}

/** Trigger element of depth-1 popup (lives outside any popup, on the host
 *  screen — a cloud indicator, a link popover span, …). */
let rootTrigger: HTMLElement | null = null;
/** Open popups, depth 1..N, in order. */
let chain: ChainEntry[] = [];
let closeTimer: number | null = null;
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

function cancelCloseTimer(): void {
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function scheduleClose(): void {
  if (closeTimer !== null) return;
  closeTimer = window.setTimeout(() => {
    closeTimer = null;
    closeChain();
  }, CLOSE_DELAY_MS);
}

/** True when `node` lies inside the root trigger or any currently open popup
 *  of the chain — the "hover island" that keeps the chain alive. */
function withinIsland(node: Node | null): boolean {
  if (node === null) return false;
  if (rootTrigger !== null && rootTrigger.contains(node)) return true;
  for (const entry of chain) {
    if (entry.el.contains(node)) return true;
  }
  return false;
}

function closeChain(): void {
  for (const entry of chain) entry.el.remove();
  chain = [];
  rootTrigger = null;
  cancelCloseTimer();
}

/** Drops every open popup deeper than `maxDepth` (a new nested open replaces
 *  whatever nested chain was open before it, like re-hovering a sibling link). */
function truncateChainTo(maxDepth: number): void {
  while (chain.length > 0 && chain[chain.length - 1]!.depth > maxDepth) {
    chain.pop()!.el.remove();
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
  popup.append(el('div', 'hp-head', content.title), (() => {
    const bodyWrap = div('hp-body');
    bodyWrap.append(content.body);
    return bodyWrap;
  })());
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
  chain.push({ depth, el: popupEl, triggerEl: candidate });
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

    if (chain.length > 0) {
      if (withinIsland(target)) cancelCloseTimer();
      else scheduleClose();
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
      closeChain();
      cancelPendingOpen();
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
  MAX_DEPTH,
  OPEN_DEBOUNCE_MS,
  CLOSE_DELAY_MS,
};
