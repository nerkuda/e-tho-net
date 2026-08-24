/**
 * Persisted window geometry for the main Electron window.
 *
 * Stored in `client_meta` (L5, per-installation) under `WINDOW_BOUNDS`. JSON:
 * `{ "x": px, "y": px, "width": px, "height": px }`. Values are rounded
 * integers. Key names mirror the {@link WindowBounds} interface so a plain
 * `JSON.stringify(bounds)` round-trips through `parseBounds`.
 */
import type { LocalDb } from './db/local-db.js';
import { CLIENT_META_KEY } from '@etn/shared';

/** Minimal display description (subset of Electron `screen.Display`). */
export interface DisplayLike {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Persisted window geometry in screen coordinates. */
export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Default window geometry used when no valid persisted value exists. */
export const DEFAULT_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
};

/** Smallest window size that still leaves room for the toolbar/canvas chrome. */
export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 480;

/**
 * How much of the window title bar must remain inside a display for the
 * window to count as "reachable". Smaller than this and the user cannot drag
 * it back onto the screen.
 */
const TITLE_VISIBLE_PX = 80;

/**
 * Loads persisted bounds. Returns `null` when nothing was saved, or the
 * stored payload could not be parsed.
 */
export function loadWindowBounds(db: LocalDb): WindowBounds | null {
  const raw = db.getMeta(CLIENT_META_KEY.WINDOW_BOUNDS);
  if (raw === null) return null;
  return parseBounds(raw);
}

/**
 * Persists `bounds` to `client_meta`. Silently ignores invalid input rather
 * than corrupting the store.
 */
export function saveWindowBounds(db: LocalDb, bounds: WindowBounds): void {
  if (!isFiniteBounds(bounds)) return;
  db.setMeta(CLIENT_META_KEY.WINDOW_BOUNDS, JSON.stringify(bounds));
}

/**
 * Picks the persisted bounds that fit a reachable display, or returns
 * `DEFAULT_BOUNDS` when no display accepts them. Pure — no Electron deps.
 *
 * A display "accepts" the bounds when:
 *  - at least {@link TITLE_VISIBLE_PX} of the window's top edge sits inside it
 *    (so the user can still grab the title bar);
 *  - the window's width and height are not larger than the display's work area.
 *
 * When no display accepts the bounds, we look at the **largest** available
 * display and shrink-to-fit there (clamped to {@link MIN_WIDTH}×{@link MIN_HEIGHT}).
 */
export function sanitizeBounds(
  bounds: WindowBounds | null,
  displays: readonly DisplayLike[],
): WindowBounds {
  if (bounds !== null && isFiniteBounds(bounds)) {
    for (const d of displays) {
      if (displayAccepts(d, bounds)) return clampToDisplay(d, bounds);
    }
  }
  return defaultBoundsFor(displays);
}

/** Strict parse: rejects non-finite numbers, missing fields, or wrong shape. */
export function parseBounds(raw: string): WindowBounds | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  const x = num(o['x']);
  const y = num(o['y']);
  // Field names match {@link WindowBounds} (`width` / `height`) so the value
  // round-trips through `JSON.stringify`. Legacy rows from the early draft
  // (which used `w` / `h`) are still readable — see unit tests.
  const w = num(o['width']) ?? num(o['w']);
  const h = num(o['height']) ?? num(o['h']);
  if (x === null || y === null || w === null || h === null) return null;
  const bounds: WindowBounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
  };
  return isFiniteBounds(bounds) ? bounds : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isFiniteBounds(b: WindowBounds): boolean {
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    Number.isFinite(b.width) &&
    Number.isFinite(b.height) &&
    b.width > 0 &&
    b.height > 0
  );
}

function displayAccepts(d: DisplayLike, b: WindowBounds): boolean {
  const { x, y, width, height } = d.bounds;
  if (b.width > width || b.height > height) return false;
  const visibleStartX = Math.max(b.x, x);
  const visibleEndX = Math.min(b.x + b.width, x + width);
  const visibleStartY = Math.max(b.y, y);
  const visibleEndY = Math.min(b.y + TITLE_VISIBLE_PX, y + height);
  return visibleEndX - visibleStartX > 0 && visibleEndY - visibleStartY >= TITLE_VISIBLE_PX;
}

function clampToDisplay(d: DisplayLike, b: WindowBounds): WindowBounds {
  const { x, y, width, height } = d.bounds;
  const w = Math.min(Math.max(b.width, MIN_WIDTH), width);
  const h = Math.min(Math.max(b.height, MIN_HEIGHT), height);
  const maxX = x + width - w;
  const maxY = y + height - h;
  return {
    x: Math.min(Math.max(b.x, x), maxX),
    y: Math.min(Math.max(b.y, y), maxY),
    width: w,
    height: h,
  };
}

function defaultBoundsFor(displays: readonly DisplayLike[]): WindowBounds {
  if (displays.length === 0) return DEFAULT_BOUNDS;
  const largest = displays.reduce<DisplayLike>((best, d) => {
    const a = best.bounds.width * best.bounds.height;
    const b = d.bounds.width * d.bounds.height;
    return b > a ? d : best;
  }, displays[0]!);
  const { x, y, width, height } = largest.bounds;
  const w = Math.min(DEFAULT_BOUNDS.width, width);
  const h = Math.min(DEFAULT_BOUNDS.height, height);
  return {
    x: x + Math.floor((width - w) / 2),
    y: y + Math.floor((height - h) / 2),
    width: w,
    height: h,
  };
}
