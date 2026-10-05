/**
 * Focus-change transition choreography (спека «FLIP-анимация холста», задачи
 * e9f0af94 / 380cc1e2, 08-ui-spec.md §2.8).
 *
 * The data (store/focus) changes immediately; only the VISUAL swap is deferred.
 * After the canvas has re-rendered into the new layout this module plays a
 * TWO-PHASE choreography over that fresh DOM, using the previous layout captured
 * by {@link captureClouds}. Inside a phase every movement starts at once; phase 2
 * starts strictly after phase 1 has finished.
 *
 *   Phase 1 — simultaneous move (`--anim-focus-flight`). One clone of the new
 *     focus cloud flies from the selected cloud's old slot into the centre. At
 *     the SAME time the former focus leaves the centre — its held clone glides
 *     into the former focus's new zone (or dissolves when it is gone) without
 *     waiting for the flyer to land. All other visible clouds glide to their new
 *     places (zone changes AND slot-only reorders), and clouds gone with the new
 *     focus fade out. A cloud that changes ZONE plays through a clone in the
 *     unclipped animation layer — the destination zone crops its content, so a
 *     transform on the real cloud would be invisible mid-flight (приёмка
 *     380cc1e2); a slot-only reorder stays on the real element. The centre's real
 *     content is swapped to the new focus only at the flyer's landing, so the new
 *     focus never flashes in the centre before the swap. Link overlays hide (and
 *     stop catching the pointer) for the move.
 *
 *   Swap — the flyer and the held former-focus clone come off, the real new
 *     focus cloud appears exactly where the flyer landed, and the former focus's
 *     zone cloud is revealed at the very spot its clone reached.
 *
 *   Phase 2 — new clouds fly out (`--anim-focus-settle`). Begins only when
 *     phase 1 is over: every cloud first seen in the new layout flies out of its
 *     source cloud, fading in on its slot — parents and children of the new
 *     focus from the focus cloud, siblings (родственники) from a visible parent
 *     cloud (`planEnteringSources`). This shows how the new neighbourhood is
 *     connected to what is already on screen.
 *
 * After phase 2 the link overlays are redrawn against the settled layout and
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
 *
 * `playFocusTransition` MUST be called in the SAME synchronous task as the DOM
 * rebuild of the focus row (`render()` in `canvas.ts`): it hides the real new
 * focus cloud and lays the departing former-focus clone over it before
 * returning, so the very first painted frame of the new state already shows the
 * old content in the centre. An `await` between the rebuild and this call lets
 * the browser paint a frame with the new focus content in place — the flicker
 * the acceptance rejected (дефект 1 задачи e9f0af94). `guard-focus-animation`
 * protects this.
 */

import { div } from '../lib/dom.js';
import {
  flipTransform,
  planEnteringSources,
  planFocusTransition,
  resolveFocusFlightOrigin,
  type FocusSourceTopology,
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
  /** Одно общее проявление расклада после смены мыслесети (`--anim-network-reveal`). */
  reveal: number;
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
    reveal: ms('--anim-network-reveal'),
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

/**
 * Учёт артефактов перехода: запланированные таймеры, запущенные анимации и
 * снапшоты инлайн-стилей облачков. Общий для фокус-хореографии
 * ({@link playFocusTransition}) и проявления расклада ({@link playNetworkReveal}):
 * оба меняют одни и те же три инлайн-свойства и обязаны одинаково их вернуть —
 * поэтому снапшот/восстановление и отмена анимаций живут здесь, а не дублируются
 * в каждом переходе. Владение мутациями — у вызывающего (`active`), который
 * зовёт {@link settle} при штатном завершении и {@link rollback} при досрочной
 * остановке/сбое.
 */
interface InlineStyleTrack {
  /** Запоминает текущие инлайн-стили элемента ДО первой мутации. */
  remember(el: HTMLElement): void;
  /** Планирует колбэк и запоминает его таймер для отмены. */
  schedule(fn: () => void, ms: number): void;
  /** Запускает анимацию и запоминает её для отмены. */
  animate(el: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): void;
  /** Восстанавливает инлайн-стили всех запомненных элементов. */
  restoreInline(): void;
  /**
   * Штатное завершение: остановить оставшиеся таймеры и вернуть инлайн-стили,
   * НЕ отменяя уже доигранные анимации.
   */
  settle(): void;
  /**
   * Полный откат (досрочная остановка/сбой): снять таймеры, отменить анимации
   * и вернуть инлайн-стили.
   */
  rollback(): void;
}

/** Создаёт пустой {@link InlineStyleTrack}. */
function createInlineStyleTrack(): InlineStyleTrack {
  const timers: number[] = [];
  const animations: Animation[] = [];
  const inline: InlineSnapshot[] = [];

  const restoreInline = (): void => {
    for (const snap of inline) {
      setStyle(snap.el, 'opacity', snap.opacity);
      setStyle(snap.el, 'pointer-events', snap.pointerEvents);
      setStyle(snap.el, 'transform-origin', snap.transformOrigin);
    }
    inline.length = 0;
  };

  return {
    remember(el: HTMLElement): void {
      inline.push({
        el,
        opacity: el.style.getPropertyValue('opacity'),
        pointerEvents: el.style.getPropertyValue('pointer-events'),
        transformOrigin: el.style.getPropertyValue('transform-origin'),
      });
    },
    schedule(fn: () => void, ms: number): void {
      timers.push(window.setTimeout(fn, ms));
    },
    animate(el: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
      animations.push(el.animate(keyframes, options));
    },
    restoreInline,
    settle(): void {
      for (const timer of timers) window.clearTimeout(timer);
      timers.length = 0;
      animations.length = 0;
      restoreInline();
    },
    rollback(): void {
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
      restoreInline();
    },
  };
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
 * former-focus clone is released, the real clouds are shown, clones and layers
 * are removed. Called at the START of every render (and on unmount) so a real
 * data update arriving mid-flight wins immediately and never gets clobbered or
 * rolled back.
 */
export function finishFocusTransition(): void {
  if (active === null) return;
  const current = active;
  active = null;
  transitionGeneration++;
  // `cleanup` owns the restoration of every inline style the transition
  // mutated; if `swap` throws, running it from a `finally` is the difference
  // between a settled canvas and permanently hidden clouds (ошибка 66deb70a).
  try {
    current.swap();
  } finally {
    current.cleanup();
  }
}

/** Sets one inline style property (works against the test DOM shim too). */
function setStyle(el: HTMLElement | SVGElement, name: string, value: string): void {
  el.style.setProperty(name, value);
}

/** Absolute (host-relative) box for a snapshot. */
function toLocal(hostRect: RectLike, r: RectLike): RectLike {
  return { left: r.left - hostRect.left, top: r.top - hostRect.top, width: r.width, height: r.height };
}

/** FLIP start transform as a CSS `transform` string. `sx === sy` из
 *  {@link flipTransform} (ошибка 9e1b87c9): единый коэффициент по обеим осям,
 *  поэтому `scale(s, s)` не сплющивает и не растягивает глифы перелетающего
 *  облачка, когда пропорции его старого и нового слотов разные. */
function flipTo(before: RectLike, after: RectLike): string {
  const { dx, dy, sx, sy } = flipTransform(before, after);
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/** Transform placing an element that currently sits at `from` so it reads at
 *  `to` (the counterpart of {@link flipTo}'s start transform for a travel that
 *  is expressed as an END keyframe — the departing former-focus clone). */
function moveTo(from: RectLike, to: RectLike): string {
  return flipTo(to, from);
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
 *  вызывающий мягко деградирует до свопа без клона.
 *
 *  `focusSources` — топология нового фокуса (`focusId`, видимые предки, рёбра):
 *  по ней фаза 2 выбирает источник вылета каждого нового облачка. Без неё
 *  источником служит облачко фокуса (мягкая деградация). */
export function playFocusTransition(
  host: HTMLElement,
  before: CloudSnapshot[],
  drawLinks?: () => void,
  externalOrigin?: RectLike | null,
  focusSources?: FocusSourceTopology,
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

  // Every survivor that visibly moved (zone change OR a slot move inside its
  // zone) is animated together in phase 1. The plan only knows zones, so a
  // slot-only move is decided here against the real rects — this keeps manual
  // reorder and link-change refreshes animated while a no-op re-render stays
  // still. The two kinds play differently: a slot move stays inside its
  // (scrolling, hence cropping) zone, a ZONE move must leave that zone.
  const visiblyMoved = (id: string): boolean => {
    const b = beforeMap.get(id);
    const a = afterMap.get(id);
    return b !== undefined && a !== undefined && !sameRect(b, a);
  };
  /** Survivors that changed zone — played through an unclipped clone. */
  const crossZoneMoves = plan.moving.filter(visiblyMoved);
  /** Survivors that only changed slot inside their zone — played in place. */
  const slotMoves = plan.settling.filter(visiblyMoved);
  if (
    prefersReducedMotion() ||
    (!plan.hasChanges && crossZoneMoves.length === 0 && slotMoves.length === 0)
  ) {
    drawLinks?.();
    return;
  }
  const tokens = readAnimTokens(host);
  if (tokens.flight <= 0 && tokens.settle <= 0 && tokens.fade <= 0) {
    drawLinks?.();
    return;
  }

  const generation = ++transitionGeneration;
  const track = createInlineStyleTrack();
  const schedule = track.schedule;
  const remember = track.remember;
  const hostRect = host.getBoundingClientRect();

  const play = (el: HTMLElement, keyframes: Keyframe[], ms: number, easing: string, delay = 0, fill?: FillMode): void => {
    if (ms <= 0) return;
    track.animate(el, keyframes, { duration: ms, easing, delay, ...(fill === undefined ? {} : { fill }) });
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
  let hadFlyer = false;
  /**
   * Cross-zone movers playing through clones in the animation layer: each clone
   * travels from the cloud's old zone slot to its new one while the real cloud
   * waits hidden at the destination. The zone element crops its own content
   * (`overflow-y: auto`), so a transform that parks the real cloud over its OLD
   * zone would be invisible mid-flight — the very «появляются мгновенно»
   * дефект приёмки 380cc1e2. The host-level layer is never cropped.
   */
  const zoneClones: Array<{ clone: HTMLElement; real: HTMLElement }> = [];

  // --- Swap: the flyer lands, content of the centre swaps. ------------------
  let swapped = false;
  const swap = (): void => {
    if (swapped) return;
    swapped = true;
    flyer?.remove();
    flyer = null;

    // Cross-zone movers have landed: reveal each real cloud at its new slot and
    // drop the travelling clone (see `zoneClones`).
    for (const move of zoneClones) {
      move.clone.remove();
      setStyle(move.real, 'opacity', '1');
    }
    zoneClones.length = 0;

    if (releasedEl !== null) {
      // The departing clone has reached the former focus's new zone; hand the
      // zone cloud over to the very spot the clone reached, then drop the clone.
      overlay?.remove();
      overlay = null;
      setStyle(releasedEl, 'opacity', '1');
    } else if (overlay !== null) {
      // The old focus left the neighbourhood — its dissolving clone (or a
      // zero-fade degradation) goes away with the swap.
      const el = overlay;
      overlay = null;
      el.remove();
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
    track.rollback();
    for (const move of zoneClones) move.clone.remove();
    zoneClones.length = 0;
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
    track.settle();
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

  // The owner of every inline-style mutation below is registered BEFORE the
  // first mutation (ошибка 66deb70a). The mutation block allocates clones and
  // animations, and `cleanup` is the only thing that returns the clouds to the
  // visibility captured above — anything that threw between a mutation and this
  // registration would leave the canvas visibly empty with no owner: the next
  // render's `finishFocusTransition` no-ops on `active === null`. Registering
  // the owner first, and running the mutations under `try`, makes a «mutated
  // but ownerless» canvas impossible.
  active = { swap, cleanup };

  try {
    const releasedAfter =
      plan.releasedFocus === null ? undefined : afterMap.get(plan.releasedFocus);

    // Former focus: a clone of its old focus cloud starts in the centre and
    // leaves in phase 1 — gliding into the former focus's new zone, or
    // dissolving in place when the thought is gone from the new layout. It
    // departs SIMULTANEOUSLY with the flyer (no waiting for the landing); the
    // real zone cloud stays hidden until the swap reveals it at the clone's
    // landing spot, so no frame shows the same thought twice.
    if (plan.focusChanged && oldFocus !== undefined) {
      overlay = oldFocus.el.cloneNode(true) as HTMLElement;
      setStyle(overlay, 'opacity', '1');
      placeClone(overlay, toLocal(hostRect, oldFocus));
      layer.append(overlay);
      if (releasedAfter !== undefined) {
        // `fill: 'forwards'` holds the end keyframe (the clone at its zone)
        // until the swap reveals the real cloud: the baseline transform of the
        // clone is the centre, so without the hold a race between the animation
        // end and `setTimeout(swap, flight)` could flash it back into the centre.
        play(
          overlay,
          [{ transform: 'none' }, { transform: moveTo(oldFocus, releasedAfter) }],
          tokens.flight,
          tokens.ease,
          0,
          'forwards',
        );
      } else if (tokens.fade > 0) {
        const el = overlay;
        play(el, [{ opacity: '1' }, { opacity: '0' }], tokens.fade, 'ease-out', 0, 'forwards');
        schedule(() => {
          if (overlay === el) overlay = null;
          el.remove();
        }, tokens.fade);
      }
    }

    // Flyer: a clone of the NEW focus cloud starting exactly where the
    // selection was — the selected cloud's old slot, or the clicked panel
    // element (external origin), growing into the focus slot.
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

    // The former focus's zone cloud must not show next to the travelling clone;
    // it takes over from the clone at the swap (same spot — seamless).
    if (plan.focusChanged && releasedAfter !== undefined) {
      releasedEl = releasedAfter.el;
      remember(releasedAfter.el);
      setStyle(releasedAfter.el, 'opacity', '0');
      setStyle(releasedAfter.el, 'transform-origin', 'top left');
    }

    // --- Phase 1: every visible survivor moves simultaneously. --------------
    // Slot-only reorders stay inside their scrolling zone, so their FLIP runs on
    // the real element. A ZONE change would park the real cloud over its OLD
    // zone, outside the destination zone's `overflow` box — invisible mid-flight
    // (приёмка 380cc1e2: «появляются мгновенно»). Such moves play on a clone in
    // the unclipped animation layer instead; the real cloud waits hidden at its
    // new slot and takes over at the swap.
    for (const id of slotMoves) {
      const b = beforeMap.get(id);
      const a = afterMap.get(id);
      if (b === undefined || a === undefined) continue;
      setStyle(a.el, 'transform-origin', 'top left');
      play(a.el, [{ transform: flipTo(b, a) }, { transform: 'none' }], tokens.flight, tokens.ease);
    }
    for (const id of crossZoneMoves) {
      const b = beforeMap.get(id);
      const a = afterMap.get(id);
      if (b === undefined || a === undefined) continue;
      // Degenerate timing (no flight token): no clone to play — the cloud is
      // simply already in place in its new zone.
      if (tokens.flight <= 0) continue;
      const clone = a.el.cloneNode(true) as HTMLElement;
      setStyle(clone, 'opacity', '1');
      placeClone(clone, toLocal(hostRect, b));
      layer.append(clone);
      remember(a.el);
      setStyle(a.el, 'opacity', '0');
      zoneClones.push({ clone, real: a.el });
      // `fill: 'forwards'` holds the landed frame until `swap` removes the clone
      // and reveals the real cloud at the very same spot.
      play(
        clone,
        [{ transform: 'none' }, { transform: moveTo(b, a) }],
        tokens.flight,
        tokens.ease,
        0,
        'forwards',
      );
    }

    // Clouds leaving with the old focus fade out during phase 1.
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

    // --- Phase 2: clouds new to the neighbourhood fly out of their sources. --
    // Source per entering cloud: the focus cloud for parents/children, a visible
    // parent cloud for siblings (`planEnteringSources`). The fly-out starts only
    // after phase 1 (delay = flight) and every new cloud starts together. The
    // end keyframe is held (`fill: 'both'`) so the cloud cannot drop back to the
    // inline `opacity: 0` when the animation ends (ошибка 90811979).
    const enteringSources = planEnteringSources(
      plan.entering
        .map((id) => afterMap.get(id))
        .filter((s): s is CloudSnapshot => s !== undefined)
        .map((s) => ({ id: s.id, zone: s.zone })),
      focusSources ?? { focusId: plan.focusAfter, parentIds: [], edges: [] },
    );
    for (const id of plan.entering) {
      const a = afterMap.get(id);
      if (a === undefined) continue;
      remember(a.el);
      setStyle(a.el, 'opacity', '0');
      setStyle(a.el, 'transform-origin', 'top left');
      const sourceId = enteringSources.get(id);
      const src = sourceId === undefined ? undefined : afterMap.get(sourceId);
      const keyframes: Keyframe[] =
        src !== undefined && src.id !== id
          ? [{ transform: moveTo(a, src), opacity: '0' }, { transform: 'none', opacity: '1' }]
          : [{ opacity: '0' }, { opacity: '1' }];
      play(a.el, keyframes, tokens.settle, 'ease-out', tokens.flight, 'both');
    }

    schedule(swap, tokens.flight);
    schedule(complete, tokens.flight + tokens.settle);
  } catch (err) {
    // The choreography is decoration, never the data: a failure degrades to the
    // settled layout rather than a half-mutated canvas. The full cleanup
    // restores every captured inline style, cancels the animations, drops the
    // clones/layers/timers and puts the link overlays back, so `render()` never
    // sees a rejected promise and the canvas never stays visually empty
    // (требование ошибки 66deb70a).
    active = null;
    cleanup();
    drawLinks?.();
    console.error('[focus-transition] choreography failed — snapped to the settled layout', err);
  }
}

/**
 * Проявление ВСЕГО расклада после смены мыслесети (спека «Проявление карты при
 * смене мыслесети», задача 70a99f09).
 *
 * При переходе на другую сеть прежнее содержимое убирается одномоментно (не
 * хореографией — это делает рендер холста), а новый расклад (фокус + зоны)
 * проявляется ОДНИМ общим fade-in: каждое облачко получает одну и ту же
 * opacity-анимацию `0 → 1` с нулевой задержкой, то есть все стартуют
 * одновременно на своих местах. Никаких перелётов, клонов и промежуточных
 * состояний — промежуточные мелькания загрузки сети не показываются.
 *
 * Длительность и сглаживание — токены `--anim-network-reveal` /
 * `--anim-focus-ease`; при `prefers-reduced-motion` (или нулевом токене)
 * проявление мгновенное. Владение мутациями общее с фокус-переходом
 * ({@link finishFocusTransition}): реальное обновление или следующий рендер
 * доводят проявление до финала, не оставляя облачка невидимыми.
 */
export function playNetworkReveal(host: HTMLElement, drawLinks?: () => void): void {
  finishFocusTransition();
  const clouds = captureClouds(host);
  const tokens = readAnimTokens(host);
  if (prefersReducedMotion() || tokens.reveal <= 0 || clouds.length === 0) {
    drawLinks?.();
    return;
  }
  const generation = ++transitionGeneration;
  const track = createInlineStyleTrack();

  const complete = (): void => {
    if (generation !== transitionGeneration) return;
    active = null;
    track.settle();
  };

  const cleanup = (): void => {
    track.rollback();
  };

  // Владелец регистрируется ДО первой мутации (урок ошибки 66deb70a): сбой
  // анимации обязан откатиться к видимому раскладу, а не оставить облачка
  // скрытыми без владельца стилей.
  active = { swap: () => {}, cleanup };
  try {
    for (const cloud of clouds) {
      const el = cloud.el;
      track.remember(el);
      setStyle(el, 'opacity', '0');
      track.animate(el, [{ opacity: '0' }, { opacity: '1' }], {
        duration: tokens.reveal,
        easing: tokens.ease,
        delay: 0,
        fill: 'both',
      });
    }
    drawLinks?.();
    track.schedule(complete, tokens.reveal);
  } catch (err) {
    active = null;
    cleanup();
    drawLinks?.();
    console.error('[network-reveal] reveal failed — snapped to the settled layout', err);
  }
}
