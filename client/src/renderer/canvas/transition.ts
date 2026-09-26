/**
 * Focus-change transition choreography (спека «FLIP-анимация холста», задача
 * e9f0af94, 08-ui-spec.md §2.8).
 *
 * The data (store/focus) changes immediately; only the VISUAL swap is deferred.
 * After the canvas has re-rendered into the new layout this module plays a
 * three-phase choreography over that fresh DOM, using the previous layout
 * captured by {@link captureClouds}:
 *
 *   Phase 1 — flight (`--anim-focus-flight`). A clone of the new focus cloud
 *     flies from the selected cloud's old slot into the centre. The centre
 *     itself shows the OLD focus cloud (an overlay clone) with its old content
 *     for the whole flight — the real focus cloud is revealed only at the swap,
 *     so new content never flashes in place. Survivors that changed zone glide
 *     to their new zone; survivors that only changed slot stay pinned at their
 *     old position; clouds gone with the new focus fade out; link overlays hide
 *     (and stop catching the pointer) for the whole move.
 *
 * `playFocusTransition` MUST be called in the SAME synchronous task as the DOM
 * rebuild of the focus row (`render()` in `canvas.ts`): it hides the real new
 * focus cloud and lays the held overlay over it before returning, so the very
 * first painted frame of the new state already shows the old content in the
 * centre. An `await` between the rebuild and this call lets the browser paint a
 * frame with the new focus content in place — the flicker the acceptance
 * rejected (дефект 1 задачи e9f0af94). `guard-focus-animation` protects this.
 *
 *   Swap — the flyer and the held overlay come off, the real new focus cloud
 *     appears exactly where the flyer landed, and the former focus hands off to
 *     its new zone cloud at the very spot it held.
 *
 *   Phase 2 — settle (`--anim-focus-settle`). The former focus slides from the
 *     centre into its zone, the pinned survivors glide into the new order, and
 *     the clouds new to the neighbourhood fade in.
 *
 * After the settle the link overlays are redrawn against the settled layout and
 * fade back in (`--anim-focus-fade`) — mid-flight line geometry is never shown.
 *
 * Durations and easing come from the `--anim-focus-*` tokens
 * (`styles/tokens.css`); the module holds no magic millisecond values, and the
 * tokens are zeroed under `prefers-reduced-motion` — the JS `matchMedia` check
 * additionally makes that path instant (no layers, no timers). A real update
 * arriving mid-flight calls {@link finishFocusTransition}, which snaps the move
 * to its final state before the new render; a newer transition supersedes the
 * old one. The animation layers ignore the pointer, so hover/click/drag on the
 * live clouds is never disturbed.
 */

import { div } from '../lib/dom.js';
import {
  flipTransform,
  planFocusTransition,
  resolveFocusFlightOrigin,
  type RectLike,
  type TransitionNode,
  type TransitionZone,
} from '../lib/pure.js';

/** One cloud snapshot taken before the re-render. */
export interface CloudSnapshot {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Zone the cloud occupied in the captured layout (`focus` — the focus row). */
  zone: TransitionZone;
  /** Element reference — stays valid (detached) after the re-render. */
  el: HTMLElement;
}

/** True when the user asked for reduced motion — transitions are skipped. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Zone of a rendered cloud: the focus row is marked by its own class. */
function cloudZone(cloud: HTMLElement): TransitionZone {
  if (cloud.classList.contains('focus-cloud')) return 'focus';
  const dir = cloud.dataset['dir'];
  return dir === 'parents' || dir === 'siblings' || dir === 'children' ? dir : 'children';
}

/** Snapshot of every rendered cloud (focus row + zones), viewport coords.
 *  Animation clones living in the transition/ghost layers are skipped. */
export function captureClouds(root: HTMLElement): CloudSnapshot[] {
  const out: CloudSnapshot[] = [];
  for (const cloud of Array.from(root.querySelectorAll<HTMLElement>('.cloud'))) {
    const id = cloud.dataset['id'];
    if (id === undefined) continue;
    if (cloud.closest('.cloud-ghosts') !== null) continue;
    if (cloud.closest('.focus-anim-layer') !== null) continue;
    const r = cloud.getBoundingClientRect();
    out.push({
      id,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      zone: cloudZone(cloud),
      el: cloud,
    });
  }
  return out;
}

/** Phase timings and easing read from the `--anim-focus-*` tokens (ms / CSS easing). */
interface AnimTokens {
  flight: number;
  settle: number;
  fade: number;
  ease: string;
}

/**
 * Reads the animation tokens off the canvas host. A token missing from the
 * stylesheet yields 0 — the transition degrades to instant instead of guessing
 * a duration (the tokens are declared in `styles/tokens.css` and guarded by
 * `guard-focus-animation`).
 */
function readAnimTokens(host: HTMLElement): AnimTokens {
  const cs = window.getComputedStyle(host);
  const ms = (name: string): number => {
    const value = Number.parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
  };
  const ease = cs.getPropertyValue('--anim-focus-ease').trim();
  return {
    flight: ms('--anim-focus-flight'),
    settle: ms('--anim-focus-settle'),
    fade: ms('--anim-focus-fade'),
    ease: ease === '' ? 'linear' : ease,
  };
}

/** Inline style values captured for restore. */
interface InlineSnapshot {
  el: HTMLElement;
  opacity: string;
  pointerEvents: string;
  transformOrigin: string;
}

/** Live transition — only one may run at a time for the single canvas host. */
interface ActiveTransition {
  /** Swap effects not yet run — idempotent (used by a forced finish too). */
  swap: () => void;
  /** Full cleanup of every artefact this transition created. */
  cleanup: () => void;
}

/** Generation of the latest started transition — only it may finish. */
let transitionGeneration = 0;
let active: ActiveTransition | null = null;

/**
 * Ends any running transition at once, snapping to the final layout: the held
 * focus is released, the real clouds are shown, clones and layers are removed.
 * Called at the START of every render (and on unmount) so a real data update
 * arriving mid-flight wins immediately and never gets clobbered or rolled back.
 */
export function finishFocusTransition(): void {
  if (active === null) return;
  const current = active;
  active = null;
  transitionGeneration++;
  current.swap();
  current.cleanup();
}

/** Sets one inline style property (works against the test DOM shim too). */
function setStyle(el: HTMLElement | SVGElement, name: string, value: string): void {
  el.style.setProperty(name, value);
}

/** Absolute (host-relative) box for a snapshot. */
function toLocal(hostRect: RectLike, r: RectLike): RectLike {
  return { left: r.left - hostRect.left, top: r.top - hostRect.top, width: r.width, height: r.height };
}

/** FLIP start transform as a CSS `transform` string. */
function flipTo(before: RectLike, after: RectLike): string {
  const { dx, dy, sx, sy } = flipTransform(before, after);
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/** Sub-pixel-tolerant rect equality — a cloud that did not move is not animated. */
function sameRect(a: RectLike, b: RectLike): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** Places a detached cloud clone as an absolutely positioned overlay. */
function placeClone(el: HTMLElement, local: RectLike): void {
  setStyle(el, 'position', 'absolute');
  setStyle(el, 'left', `${local.left}px`);
  setStyle(el, 'top', `${local.top}px`);
  setStyle(el, 'width', `${local.width}px`);
  setStyle(el, 'height', `${local.height}px`);
  setStyle(el, 'margin', '0');
  setStyle(el, 'pointer-events', 'none');
  setStyle(el, 'transform-origin', 'top left');
}

/** Plays the transition after the re-render (see the module doc).
 *
 *  `externalOrigin` — экранный прямоугольник кликнутого ВНЕ карты элемента
 *  (облачко панели закреплённых/истории, строка поиска, `lib/focus-origin.ts`):
 *  полёт стартует от него «со стороны клика» и имеет приоритет над слотом
 *  выбранного облачка на карте. Без пригодного источника полёт не играется —
 *  вызывающий мягко деградирует до свопа без клона. */
export function playFocusTransition(
  host: HTMLElement,
  before: CloudSnapshot[],
  drawLinks?: () => void,
  externalOrigin?: RectLike | null,
): void {
  finishFocusTransition();
  if (before.length === 0) {
    drawLinks?.();
    return;
  }
  const after = captureClouds(host);
  const nodesBefore: TransitionNode[] = before.map((s) => ({ id: s.id, zone: s.zone }));
  const nodesAfter: TransitionNode[] = after.map((s) => ({ id: s.id, zone: s.zone }));
  const plan = planFocusTransition(nodesBefore, nodesAfter);
  const beforeMap = new Map(before.map((s) => [s.id, s]));
  const afterMap = new Map(after.map((s) => [s.id, s]));

  // A same-zone slot move is invisible in the plan (it only knows zones), so it
  // is decided here against the real rects — this keeps manual reorder and
  // link-change refreshes animated while a no-op re-render stays still.
  const settleMoves = plan.settling.filter((id) => {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);
    return b !== undefined && a !== undefined && !sameRect(b, a);
  });
  if (prefersReducedMotion() || (!plan.hasChanges && settleMoves.length === 0)) {
    drawLinks?.();
    return;
  }
  const tokens = readAnimTokens(host);
  if (tokens.flight <= 0 && tokens.settle <= 0 && tokens.fade <= 0) {
    drawLinks?.();
    return;
  }

  const generation = ++transitionGeneration;
  const timers: number[] = [];
  const animations: Animation[] = [];
  const inline: InlineSnapshot[] = [];
  const hostRect = host.getBoundingClientRect();

  const schedule = (fn: () => void, ms: number): void => {
    timers.push(
      window.setTimeout(() => {
        fn();
      }, ms),
    );
  };

  const remember = (el: HTMLElement): void => {
    inline.push({
      el,
      opacity: el.style.getPropertyValue('opacity'),
      pointerEvents: el.style.getPropertyValue('pointer-events'),
      transformOrigin: el.style.getPropertyValue('transform-origin'),
    });
  };

  const play = (el: HTMLElement, keyframes: Keyframe[], ms: number, easing: string, delay = 0, fill?: FillMode): void => {
    if (ms <= 0) return;
    animations.push(el.animate(keyframes, { duration: ms, easing, delay, ...(fill === undefined ? {} : { fill }) }));
  };

  const layer = div('focus-anim-layer');
  host.append(layer);
  let ghosts: HTMLElement | null = null;

  // --- Link overlays: hidden and pointer-transparent for the whole move. ----
  const overlays = Array.from(host.querySelectorAll<SVGSVGElement>('.links-layer'));
  const overlayStyles = overlays.map((svg) => ({
    svg,
    transition: svg.style.getPropertyValue('transition'),
    opacity: svg.style.getPropertyValue('opacity'),
    pointerEvents: svg.style.getPropertyValue('pointer-events'),
  }));
  const restoreOverlays = (): void => {
    for (const s of overlayStyles) {
      setStyle(s.svg, 'transition', s.transition);
      setStyle(s.svg, 'opacity', s.opacity);
      setStyle(s.svg, 'pointer-events', s.pointerEvents);
    }
  };
  for (const s of overlayStyles) {
    setStyle(s.svg, 'transition', 'none');
    setStyle(s.svg, 'opacity', '0');
    setStyle(s.svg, 'pointer-events', 'none');
  }

  // --- Special clouds of a focus change. -----------------------------------
  const oldFocus = plan.focusBefore === null ? undefined : beforeMap.get(plan.focusBefore);
  const newFocus = plan.focusAfter === null ? undefined : afterMap.get(plan.focusAfter);
  // Flight source: a click outside the canvas wins over the cloud's old slot
  // (the selected thought may not even be on the map) — see `resolveFocusFlightOrigin`.
  const canvasOrigin = plan.flyingId === null ? null : beforeMap.get(plan.flyingId) ?? null;
  const flightOrigin = resolveFocusFlightOrigin(canvasOrigin, externalOrigin ?? null);

  let overlay: HTMLElement | null = null;
  let flyer: HTMLElement | null = null;
  let releasedEl: HTMLElement | null = null;
  let releasedFrom: RectLike | null = null;
  let hadFlyer = false;

  // Held focus: a clone of the OLD focus cloud keeps the centre unchanged while
  // the flyer travels; it is the only thing the user sees in the centre until
  // the swap (the real new focus cloud is hidden below).
  if (plan.focusChanged && oldFocus !== undefined) {
    overlay = oldFocus.el.cloneNode(true) as HTMLElement;
    setStyle(overlay, 'opacity', '1');
    placeClone(overlay, toLocal(hostRect, oldFocus));
    layer.append(overlay);
  }

  // Flyer: a clone of the NEW focus cloud starting exactly where the selection
  // was — the selected cloud's old slot, or the clicked panel element (external
  // origin), growing into the focus slot.
  if (plan.focusChanged && newFocus !== undefined && flightOrigin !== null && tokens.flight > 0) {
    flyer = newFocus.el.cloneNode(true) as HTMLElement;
    setStyle(flyer, 'opacity', '1');
    placeClone(flyer, toLocal(hostRect, newFocus));
    layer.append(flyer);
    hadFlyer = true;
    play(flyer, [{ transform: flipTo(flightOrigin, newFocus) }, { transform: 'none' }], tokens.flight, tokens.ease);
  }

  // The real new focus cloud waits hidden at its final position.
  if (plan.focusChanged && newFocus !== undefined) {
    remember(newFocus.el);
    setStyle(newFocus.el, 'opacity', '0');
    setStyle(newFocus.el, 'pointer-events', 'none');
    setStyle(newFocus.el, 'transform-origin', 'top left');
  }

  // The former focus's zone cloud must not show next to the held overlay yet;
  // it takes over from the overlay at the swap (same spot — seamless).
  if (plan.focusChanged && plan.releasedFocus !== null) {
    const released = afterMap.get(plan.releasedFocus);
    if (released !== undefined && oldFocus !== undefined) {
      releasedEl = released.el;
      releasedFrom = oldFocus;
      remember(released.el);
      setStyle(released.el, 'opacity', '0');
      setStyle(released.el, 'transform-origin', 'top left');
    }
  }

  // --- Phase 1: survivors that changed zone glide during the flight. -------
  for (const id of plan.moving) {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);
    if (b === undefined || a === undefined) continue;
    setStyle(a.el, 'transform-origin', 'top left');
    play(a.el, [{ transform: flipTo(b, a) }, { transform: 'none' }], tokens.flight, tokens.ease);
  }

  // Survivors that only change slot: pinned at the old position for the flight,
  // then settle into the new order (fill `backwards` holds the start keyframe
  // through the delay).
  for (const id of settleMoves) {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);
    if (b === undefined || a === undefined) continue;
    setStyle(a.el, 'transform-origin', 'top left');
    play(
      a.el,
      [{ transform: flipTo(b, a) }, { transform: 'none' }],
      tokens.settle,
      tokens.ease,
      tokens.flight,
      'backwards',
    );
  }

  // Clouds leaving with the old focus fade out during the flight.
  if (plan.leaving.length > 0 && tokens.fade > 0) {
    ghosts = div('cloud-ghosts');
    for (const id of plan.leaving) {
      const b = beforeMap.get(id);
      if (b === undefined) continue;
      const ghost = b.el.cloneNode(true) as HTMLElement;
      placeClone(ghost, toLocal(hostRect, b));
      ghosts.append(ghost);
      play(ghost, [{ opacity: '1' }, { opacity: '0' }], tokens.fade, 'ease-out', 0, 'forwards');
    }
    if (ghosts.childElementCount > 0) {
      host.append(ghosts);
      schedule(() => {
        ghosts?.remove();
        ghosts = null;
      }, tokens.fade);
    } else {
      ghosts = null;
    }
  }

  // Clouds new to the neighbourhood fade in after the flight.
  for (const id of plan.entering) {
    const a = afterMap.get(id);
    if (a === undefined) continue;
    remember(a.el);
    setStyle(a.el, 'opacity', '0');
    play(a.el, [{ opacity: '0' }, { opacity: '1' }], tokens.settle, 'ease-out', tokens.flight, 'backwards');
  }

  // --- Swap: the flyer lands, content of the centre swaps. ------------------
  let swapped = false;
  const swap = (): void => {
    if (swapped) return;
    swapped = true;
    flyer?.remove();
    flyer = null;

    if (releasedEl !== null && releasedFrom !== null) {
      // Hand the centre's content over to the former focus's zone cloud at the
      // very spot the overlay held, then let it slide into its zone.
      overlay?.remove();
      overlay = null;
      setStyle(releasedEl, 'opacity', '1');
      const a = afterMap.get(plan.releasedFocus ?? '');
      if (a !== undefined) {
        play(
          releasedEl,
          [{ transform: flipTo(releasedFrom, a) }, { transform: 'none' }],
          tokens.settle,
          tokens.ease,
        );
      }
    } else if (overlay !== null) {
      // The old focus left the neighbourhood — fade it out where it stood.
      const el = overlay;
      overlay = null;
      play(el, [{ opacity: '1' }, { opacity: '0' }], tokens.fade, 'ease-out', 0, 'forwards');
      schedule(() => {
        el.remove();
      }, tokens.fade);
    }

    if (newFocus !== undefined) {
      setStyle(newFocus.el, 'opacity', hadFlyer ? '1' : '0');
      setStyle(newFocus.el, 'pointer-events', '');
      if (!hadFlyer) {
        play(newFocus.el, [{ opacity: '0' }, { opacity: '1' }], tokens.settle, 'ease-out');
      }
    }
  };

  const cleanup = (): void => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
    for (const animation of animations) {
      try {
        animation.cancel();
      } catch {
        // An already-finished animation may refuse to cancel — nothing to undo.
      }
    }
    animations.length = 0;
    for (const snap of inline) {
      setStyle(snap.el, 'opacity', snap.opacity);
      setStyle(snap.el, 'pointer-events', snap.pointerEvents);
      setStyle(snap.el, 'transform-origin', snap.transformOrigin);
    }
    inline.length = 0;
    flyer?.remove();
    flyer = null;
    overlay?.remove();
    overlay = null;
    ghosts?.remove();
    ghosts = null;
    layer.remove();
    restoreOverlays();
  };

  const complete = (): void => {
    if (generation !== transitionGeneration) return;
    active = null;
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
    animations.length = 0;
    for (const snap of inline) {
      setStyle(snap.el, 'opacity', snap.opacity);
      setStyle(snap.el, 'pointer-events', snap.pointerEvents);
      setStyle(snap.el, 'transform-origin', snap.transformOrigin);
    }
    inline.length = 0;
    flyer?.remove();
    flyer = null;
    overlay?.remove();
    overlay = null;
    ghosts?.remove();
    ghosts = null;
    layer.remove();
    drawLinks?.();
    // Fade the overlays back in against the now-settled layout.
    for (const s of overlayStyles) {
      setStyle(s.svg, 'transition', `opacity ${tokens.fade}ms ease-in`);
      setStyle(s.svg, 'opacity', '1');
      setStyle(s.svg, 'pointer-events', '');
    }
    if (overlayStyles.length > 0 && tokens.fade > 0) {
      window.setTimeout(() => {
        if (generation !== transitionGeneration) return;
        for (const s of overlayStyles) {
          setStyle(s.svg, 'transition', s.transition);
          setStyle(s.svg, 'opacity', s.opacity);
          setStyle(s.svg, 'pointer-events', s.pointerEvents);
        }
      }, tokens.fade);
    } else {
      restoreOverlays();
    }
  };

  active = { swap, cleanup };

  schedule(swap, tokens.flight);
  schedule(complete, tokens.flight + tokens.settle);
}
