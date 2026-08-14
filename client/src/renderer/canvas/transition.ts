/**
 * Focus-change transition choreography (08-ui-spec.md §2.8, workplan L3).
 *
 * FLIP over the zone grids: before a focus re-render the canvas snapshots the
 * rendered clouds (id + viewport rect + element ref); after the re-render
 *
 *   * clouds that stayed visible animate transform from their old rect to the
 *     new one — the chosen thought's small cloud grows into the focus cloud,
 *     the old focus shrinks into its neighbour slot, the rest glide to place;
 *   * clouds that vanished are ghost-cloned at their old spot and fade out;
 *   * clouds that appeared fade in;
 *   * the link overlays fade out for the move and back in after it, masking
 *     the line re-geometry.
 *
 * Everything together stays well under 1 s and is skipped entirely for
 * `prefers-reduced-motion: reduce`. The ghosts layer ignores pointer events,
 * so hover/click/drag on the live clouds is never disturbed.
 */

import { div } from '../lib/dom.js';

/** One cloud snapshot taken before the re-render. */
export interface CloudSnapshot {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Element reference — stays valid (detached) after the re-render. */
  el: HTMLElement;
}

/** Rect subset used by {@link flipTransform}. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** FLIP delta: where to start the animation so the cloud lands exactly here. */
export function flipTransform(before: RectLike, after: RectLike): { dx: number; dy: number; sx: number; sy: number } {
  return {
    dx: before.left - after.left,
    dy: before.top - after.top,
    sx: before.width / Math.max(1, after.width),
    sy: before.height / Math.max(1, after.height),
  };
}

/** True when the user asked for reduced motion — transitions are skipped. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Snapshot of every rendered cloud (focus row + zones), viewport coords. */
export function captureClouds(root: HTMLElement): CloudSnapshot[] {
  const out: CloudSnapshot[] = [];
  for (const cloud of Array.from(root.querySelectorAll<HTMLElement>('.cloud[data-id]'))) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    const r = cloud.getBoundingClientRect();
    out.push({ id, left: r.left, top: r.top, width: r.width, height: r.height, el: cloud });
  }
  return out;
}

/** Combined move duration (ms); the whole choreography finishes in < 1 s. */
const MOVE_MS = 380;
const FADE_IN_MS = 260;
const GHOST_MS = 320;
const LINKS_BACK_MS = 450;

/** Plays the transition after the re-render (see the module doc). */
export function playFocusTransition(
  host: HTMLElement,
  before: CloudSnapshot[],
  drawNow?: () => void,
): void {
  if (prefersReducedMotion()) {
    drawNow?.();
    return;
  }

  const hostRect = host.getBoundingClientRect();
  const afterRects = new Map<string, RectLike>();
  const afterEls = new Map<string, HTMLElement>();
  for (const cloud of Array.from(host.querySelectorAll<HTMLElement>('.cloud[data-id]'))) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    const r = cloud.getBoundingClientRect();
    afterEls.set(id, cloud);
    afterRects.set(id, { left: r.left, top: r.top, width: r.width, height: r.height });
  }
  const beforeMap = new Map(before.map((s) => [s.id, s]));

  // Link geometry must be computed against the FINAL, untransformed cloud
  // positions. Depending on rAF ordering was not enough: the debounced redraw
  // could land after the FLIP animations applied their first keyframe and
  // capture mid-flight geometry — leaving lines pointing "nowhere" after the
  // clouds landed. So: hide the overlays instantly, redraw synchronously,
  // THEN start the animations and fade the overlays back in after the move.
  const overlays = host.querySelectorAll<SVGSVGElement>('[class*="links-overlay"]');
  for (const svg of overlays) {
    svg.style.transition = 'none';
    svg.style.opacity = '0';
  }
  drawNow?.();

  // Survivors glide from their old position (FLIP).
  for (const [id, el] of afterEls) {
    const b = beforeMap.get(id);
    if (b === undefined) {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(10px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: FADE_IN_MS, easing: 'ease-out' },
      );
      continue;
    }
    const { dx, dy, sx, sy } = flipTransform(b, afterRects.get(id) ?? el.getBoundingClientRect());
    if (Math.abs(dx) + Math.abs(dy) < 2 && Math.abs(sx - 1) + Math.abs(sy - 1) < 0.05) {
      continue; // same spot — nothing to animate
    }
    el.style.transformOrigin = 'top left';
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: 'none' },
      ],
      { duration: MOVE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
  }

  // Vanished clouds: ghost clones fade out where they were.
  const ghosts = div('cloud-ghosts');
  for (const b of before) {
    if (afterEls.has(b.id)) continue;
    const clone = b.el.cloneNode(true) as HTMLElement;
    clone.style.position = 'absolute';
    clone.style.left = `${b.left - hostRect.left}px`;
    clone.style.top = `${b.top - hostRect.top}px`;
    clone.style.width = `${b.width}px`;
    clone.style.height = `${b.height}px`;
    clone.style.margin = '0';
    ghosts.append(clone);
    clone.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: GHOST_MS,
      easing: 'ease-out',
      fill: 'forwards',
    });
  }
  if (ghosts.childElementCount > 0) {
    host.append(ghosts);
    window.setTimeout(() => ghosts.remove(), GHOST_MS + 80);
  }

  // Fade the overlays back in once the clouds have landed, then clean up.
  if (overlays.length > 0) {
    window.setTimeout(() => {
      for (const svg of overlays) {
        svg.style.transition = 'opacity 250ms ease-in';
        svg.style.opacity = '1';
      }
      window.setTimeout(() => {
        for (const svg of overlays) {
          svg.style.transition = '';
          svg.style.opacity = '';
        }
      }, 260);
    }, LINKS_BACK_MS);
  }
}
