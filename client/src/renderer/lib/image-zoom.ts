/**
 * Ctrl-hover image magnifier (08-ui-spec.md §13, workplan L2, L16).
 *
 * Holding Ctrl while hovering any rendered picture (history bar, search
 * results, attachment/link lists, editor headers, markdown pictures — any
 * `<img>`, and SVG `<image>` elements, such as the thought icons the editor's
 * local graph draws inside its canvas) shows it at its natural size next to
 * the cursor, capped at 70% of the window width/height. Purely visual: the
 * popup ignores pointer events, so it never disturbs hover/click handling
 * underneath.
 *
 * Thought icons backed by an attachment (L16) carry `data-zoom-thought` /
 * `data-zoom-attachment` (set by `applyThoughtIcon`, and by the mini-graph for
 * its SVG icons): the popup then shows the attachment's full picture instead
 * of the icon-sized preview, resolving the attachment's file lazily and
 * caching it for a minute.
 *
 * One delegated listener set on the document — no per-list wiring.
 */

import { etnimgUrl } from '../editor/markdown-field.js';
import { etn } from './etn.js';
import { el } from './dom.js';
import { store } from '../state.js';

/** Cursor offset from the pointer to the popup corner (px). */
const POPUP_OFFSET = 14;

/** How long a resolved attachment file path is cached (ms). */
const ATTACH_PATH_TTL_MS = 60_000;

/** Attachment id → file path (null = missing), cached per thought (L16). */
const attachPathCache = new Map<string, { path: string | null; at: number }>();

/**
 * Resolves the file path of the attachment backing a thought icon. Falls back
 * to `null` (the popup keeps showing the icon preview) when the attachment is
 * gone, not an image or the request fails.
 */
async function resolveIconAttachment(
  thoughtId: string,
  attachmentId: string,
): Promise<string | null> {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const key = `${networkId}:${thoughtId}:${attachmentId}`;
  const hit = attachPathCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < ATTACH_PATH_TTL_MS) return hit.path;
  let path: string | null = null;
  try {
    const list = await etn.attachments.list(networkId, 'thought', thoughtId);
    path = list.find((a) => a.id === attachmentId)?.file_path ?? null;
  } catch {
    path = null;
  }
  attachPathCache.set(key, { path, at: Date.now() });
  return path;
}

/**
 * True when enlarging makes sense: the image has loaded and at least one side
 * is displayed smaller than its natural size.
 */
export function zoomable(
  natural: { w: number; h: number },
  displayed: { w: number; h: number },
): boolean {
  return natural.w > 0 && natural.h > 0 && (displayed.w < natural.w || displayed.h < natural.h);
}

/**
 * A rendered picture the magnifier can anchor to: an HTML `<img>` anywhere in
 * the UI, or an SVG `<image>` — the only SVG-rendered icons in the client are
 * the thought icons of the editor's local graph (`editor/mini-graph.ts`).
 */
type ZoomAnchor = HTMLImageElement | SVGImageElement;

function isZoomAnchor(node: EventTarget | null): node is ZoomAnchor {
  return node instanceof HTMLImageElement || node instanceof SVGImageElement;
}

/**
 * Source URL of an anchor. `SVGImageElement` has no `src`/`currentSrc` — the
 * URL lives in `href` (the mini-graph writes `xlink:href` alongside it).
 */
function anchorSrc(anchor: ZoomAnchor): string {
  if (anchor instanceof HTMLImageElement) return anchor.currentSrc || anchor.src;
  return (
    anchor.getAttribute('href') ??
    anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
    ''
  );
}

/**
 * Displayed size of an anchor, px. An SVG `<image>` has no `width`/`height`
 * content attributes to read that from — its rendered box is what counts
 * (the viewport's own scale included, so a zoomed-in graph measures correctly).
 */
function displayedSize(anchor: ZoomAnchor): { w: number; h: number } {
  if (anchor instanceof HTMLImageElement) return { w: anchor.width, h: anchor.height };
  const rect = anchor.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

/** Measured natural sizes of SVG `<image>` sources, keyed by URL. */
const naturalSizeCache = new Map<string, { w: number; h: number }>();

/** Cap for {@link naturalSizeCache}: icons change rarely, but a session can
 *  still see many distinct ones (every data URL is a full-size key). */
const NATURAL_SIZE_CACHE_LIMIT = 100;

/**
 * Natural size of an SVG `<image>` source. Unlike an `<img>`, the element
 * knows nothing about its content's size, so the URL is measured by loading it
 * — the same URL the popup will show, which makes the second use free
 * (browser cache). An unloadable source measures `0×0`, i.e. not zoomable.
 */
function measureNaturalSize(url: string): Promise<{ w: number; h: number }> {
  const hit = naturalSizeCache.get(url);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const probe = new Image();
    const done = (w: number, h: number): void => {
      if (naturalSizeCache.size >= NATURAL_SIZE_CACHE_LIMIT) {
        const oldest = naturalSizeCache.keys().next().value;
        if (oldest !== undefined) naturalSizeCache.delete(oldest);
      }
      naturalSizeCache.set(url, { w, h });
      resolve({ w, h });
    };
    probe.addEventListener('load', () => done(probe.naturalWidth, probe.naturalHeight), {
      once: true,
    });
    probe.addEventListener('error', () => done(0, 0), { once: true });
    probe.src = url;
  });
}

let initialized = false;

/** Installs the document-level magnifier (idempotent; called once from boot). */
export function initImageZoom(): void {
  if (initialized) return;
  initialized = true;

  const popup = el('img', 'image-zoom-popup hidden');
  popup.alt = '';
  document.body.append(popup);

  let current: ZoomAnchor | null = null;
  let mouseX = 0;
  let mouseY = 0;
  /**
   * Bumped whenever the anchor changes or the popup hides. An SVG anchor's
   * size is measured asynchronously — a measurement that lands after the
   * cursor moved on must not open a popup for a stale icon.
   */
  let generation = 0;

  const hide = (): void => {
    generation++;
    current = null;
    popup.classList.add('hidden');
  };

  /** Places the popup beside the cursor, keeping it inside the window. */
  const place = (): void => {
    const rect = popup.getBoundingClientRect();
    let left = mouseX + POPUP_OFFSET;
    let top = mouseY + POPUP_OFFSET;
    if (left + rect.width > window.innerWidth) {
      left = Math.max(0, mouseX - rect.width - POPUP_OFFSET);
    }
    if (top + rect.height > window.innerHeight) {
      top = Math.max(0, mouseY - rect.height - POPUP_OFFSET);
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  };

  /** Shows `src` for `anchor`; `zoom` (attachment-backed icon, L16) swaps the
   *  icon-sized preview for the attachment's full picture once it resolves. */
  const present = (
    anchor: ZoomAnchor,
    src: string,
    zoom: { thought: string; attachment: string } | null,
  ): void => {
    popup.src = src;
    popup.classList.remove('hidden');
    place();
    if (zoom === null) return;
    void resolveIconAttachment(zoom.thought, zoom.attachment).then((filePath) => {
      if (current !== anchor || filePath === null || filePath === '') return;
      popup.src = etnimgUrl(filePath);
      // The full picture can differ in size from the preview — re-place it.
      popup.addEventListener(
        'load',
        () => {
          if (current === anchor) place();
        },
        { once: true },
      );
    });
  };

  const show = (anchor: ZoomAnchor): void => {
    const src = anchorSrc(anchor);
    if (src === '') return;
    const zoomThought = anchor.dataset['zoomThought'] ?? '';
    const zoomAttachment = anchor.dataset['zoomAttachment'] ?? '';
    const hasZoomSource = zoomThought !== '' && zoomAttachment !== '';
    current = anchor;
    const mine = ++generation;
    if (hasZoomSource) {
      present(anchor, src, { thought: zoomThought, attachment: zoomAttachment });
      return;
    }
    if (anchor instanceof HTMLImageElement) {
      const natural = { w: anchor.naturalWidth, h: anchor.naturalHeight };
      if (!zoomable(natural, displayedSize(anchor))) hide();
      else present(anchor, src, null);
      return;
    }
    // SVG `<image>`: the element knows nothing about its content's size, so
    // decide after measuring the URL (never opening a popup for an icon that
    // is displayed at — or above — its natural size).
    void measureNaturalSize(src).then((natural) => {
      if (mine !== generation || current !== anchor) return;
      if (!zoomable(natural, displayedSize(anchor))) hide();
      else present(anchor, src, null);
    });
  };

  // Hover enters a picture with Ctrl held — magnify; leaving it — hide.
  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (event.ctrlKey && isZoomAnchor(target)) {
      show(target);
      return;
    }
    if (current !== null && target !== current) hide();
  });

  // Ctrl pressed while already hovering a picture (no new mouseover fires).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hide();
      return;
    }
    if (event.key === 'Control' && current === null) {
      const at = document.elementFromPoint(mouseX, mouseY);
      if (isZoomAnchor(at)) show(at);
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') hide();
  });

  document.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (current === null) return;
    if (!event.ctrlKey) {
      hide();
      return;
    }
    place();
  });

  // Any scroll moves the anchored picture away from its icon — close it.
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
