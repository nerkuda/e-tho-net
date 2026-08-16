/**
 * Ctrl-hover image magnifier (08-ui-spec.md §13, workplan L2).
 *
 * Holding Ctrl while hovering any rendered image icon (history bar, search
 * results, attachment/link lists, editor headers, markdown pictures — any
 * `<img>`) shows the picture at its natural size next to the cursor, capped at
 * 70% of the window width/height. Purely visual: the popup ignores pointer
 * events, so it never disturbs hover/click handling underneath.
 *
 * One delegated listener set on the document — no per-list wiring.
 */

import { el } from './dom.js';

/** Cursor offset from the pointer to the popup corner (px). */
const POPUP_OFFSET = 14;

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

let initialized = false;

/** Installs the document-level magnifier (idempotent; called once from boot). */
export function initImageZoom(): void {
  if (initialized) return;
  initialized = true;

  const popup = el('img', 'image-zoom-popup hidden');
  popup.alt = '';
  document.body.append(popup);

  let current: HTMLImageElement | null = null;
  let mouseX = 0;
  let mouseY = 0;

  const hide = (): void => {
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

  const show = (img: HTMLImageElement): void => {
    if (
      !zoomable(
        { w: img.naturalWidth, h: img.naturalHeight },
        { w: img.width, h: img.height },
      )
    ) {
      return;
    }
    current = img;
    popup.src = img.currentSrc || img.src;
    popup.classList.remove('hidden');
    place();
  };

  // Hover enters an image with Ctrl held — magnify; leaving it — hide.
  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (event.ctrlKey && target instanceof HTMLImageElement) {
      show(target);
      return;
    }
    if (current !== null && target !== current) hide();
  });

  // Ctrl pressed while already hovering an image (no new mouseover fires).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hide();
      return;
    }
    if (event.key === 'Control' && current === null) {
      const at = document.elementFromPoint(mouseX, mouseY);
      if (at instanceof HTMLImageElement) show(at);
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
