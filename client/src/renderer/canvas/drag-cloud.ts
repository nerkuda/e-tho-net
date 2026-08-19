/**
 * Canvas cloud drag-n-drop (08-ui-spec.md §2.3.1, §5.5, §11.1).
 *
 * A pointer gesture (mousedown → move → mouseup) started from any cloud of the
 * parents/children zones, from a siblings-zone cloud or the focus cloud (no
 * zone of origin — they drag like list entries), **or from a thought list
 * entry** (selection panel row, history mini-cloud, history dropdown row,
 * pinned chip — `wireExternalDragSource`); modifier keys are read live while
 * dragging:
 *
 * - **plain drag** — drop on the top ellipse of cloud Б → create A→Б (A becomes
 *   Б's parent); drop on the body (or bottom ellipse) of cloud Б → create Б→A;
 *   drop on a **different** orderable zone (parents↔children) → flip the
 *   dragged thought's link direction to the focused thought (move — a thought
 *   dragged from a list gets the link created); drop inside the same zone, on
 *   the siblings zone or outside any target → nothing (a plain drag never
 *   changes the manual order);
 * - **Ctrl/Cmd drag** — drop on any part of cloud Б → move the dragged thought
 *   into subordination of Б: every existing parent link of the dragged thought
 *   is replaced by a single Б→A link (no copy);
 * - **Ctrl+Shift drag** — reorder inside the dragged thought's zone, only while
 *   the zone is sorted `manual`: a drop on cloud Б puts A right **before** Б.
 *   The target cloud is highlighted (green) live; nothing else moves until the
 *   drop — then the refreshed zone shifts the following clouds and FLIP-animates
 *   them to their final positions (not available to list entries, which have no
 *   zone of origin);
 * - **drop onto the selection panel** — the dragged thought joins the selection
 *   (no-op when it was dragged from the selection itself);
 * - **drop onto the history bar / history dropdown** — the dragged thought is
 *   opened the same way a click on a history entry opens it (no-op when it was
 *   dragged from the history itself).
 *
 * A gesture rather than HTML5 drag-n-drop: Chromium intercepts modifier-key
 * drags in several ways (Alt+drag is link selection, a lone Alt focuses the
 * menu bar), and a gesture reads the modifiers live mid-drag anyway. The
 * per-zone ellipse-drag gesture (canvas.ts, `wireEllipseDrag`) is untouched.
 *
 * Existing links are reused (server 409 → no-op); the reverse link, if any, is
 * removed first and its type carried over to the new link.
 */

import { type Link, type ThoughtLinksGrouped } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { closeMenu } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId, scheduleRefresh } from '../app.js';
import { store } from '../state.js';
import { DRAG_THRESHOLD_PX, requestZoneAnimation, suppressNextCanvasClick } from './canvas.js';

type OrderableDir = 'parents' | 'children';
type ZoneDir = 'parents' | 'children' | 'siblings';
type LinkMode = 'parent' | 'child';
/** Where the drag started: a zone cloud or a thought list (selection/history/pinned). */
type DragOrigin = 'cloud' | 'selection' | 'history' | 'pinned';

interface DraggedCloud {
  id: string;
  /** The zone the cloud came from — absent for list entries (no zone semantics). */
  dir?: OrderableDir;
  origin: DragOrigin;
}

type DropKind =
  | 'link-parent'
  | 'link-child'
  | 'reparent'
  | 'move'
  | 'reorder'
  | 'add-to-selection'
  | 'open-history'
  | 'pin'
  | 'none';

interface DropTarget {
  kind: DropKind;
  /** Thought the dragged cloud lands on (link/reparent modes). */
  targetThoughtId?: string;
  /** Zone the drop happens in (move; a no-op drop inside the dragged's own
   *  zone keeps the last target, so the highlight survives pointer passes
   *  over the grid gaps between clouds). */
  zoneDir?: ZoneDir;
  /** Insertion index into the zone's order without the dragged id (reorder). */
  insertIndex?: number;
  /** Element to highlight and the class to apply. */
  highlightEl?: HTMLElement;
  highlightCls?: string;
}

/** In-flight pointer drag of a zone cloud or a list entry. */
interface CloudDragGesture {
  id: string;
  dir?: OrderableDir;
  origin: DragOrigin;
  /** True when the gesture started on a dropdown row — the menu must close on drop. */
  fromMenu?: boolean;
  startX: number;
  startY: number;
  active: boolean;
  /** The pressed element — dimmed in place while its ghost follows the cursor. */
  source: HTMLElement;
  /** Clone of the source following the cursor (`pointer-events: none`). */
  ghost: HTMLElement | null;
  /** Drop target resolved by the last mousemove — the drop applies it, so the
   *  preview is always WYSIWYG (a modifier released a tick before the mouse
   *  button cannot silently change the drop). */
  lastTarget: DropTarget | null;
}

/** Accessors into the canvas module (current manual order). */
export interface DragAccessors {
  /** Full ordered thought-id list of an orderable zone (deduped, display order). */
  getZoneOrder: (dir: OrderableDir) => string[];
}

let gesture: CloudDragGesture | null = null;
let highlighted: HTMLElement | null = null;
/** Canvas accessors, captured at wiring; the window gesture handlers need them. */
let accessors: DragAccessors | null = null;
/** Panel actions, registered by the selection/history modules at mount. */
let dropActions: ListDropActions = {};

/** Drop actions provided by the thought list panels (selection, history, pins). */
export interface ListDropActions {
  addToSelection?: (ids: string[]) => void;
  openEntry?: (id: string) => void;
  /**
   * The pinned panel resolves drops onto its own DOM: `el` under the cursor,
   * `x` — the cursor X for the between-chips position. Returns the insertion
   * index in the FULL pinned list, or `null` when the point is elsewhere.
   */
  resolvePinTarget?: (el: HTMLElement, x: number) => { dropIndex: number; highlightEl: HTMLElement } | null;
  /** Pins the thought at the drop index (re-pinning an existing pin reorders). */
  pinThought?: (id: string, dropIndex: number) => void;
  /** Called when the drag gesture ends (drop or cancel) — the pinned panel
   *  hides its insertion marker here. */
  onDragEnd?: () => void;
}

/** Registers list-panel drop actions (called by the panels at mount). */
export function registerDropActions(actions: ListDropActions): void {
  dropActions = { ...dropActions, ...actions };
}

/**
 * Wires the cloud drag gesture onto the canvas host: mousedown on a zone cloud
 * starts it; mousemove/mouseup are tracked on the window (like the ellipse
 * gesture) so the drag survives leaving the cloud.
 */
export function wireCloudDrag(host: HTMLElement, acc: DragAccessors): void {
  accessors = acc;
  host.addEventListener('mousedown', (event) => onCloudMouseDown(event));
}

/**
 * Wires a thought list entry (selection panel row, history mini-cloud, history
 * dropdown row) as a drag source of the same gesture. A list entry has no zone
 * of origin: Ctrl+Shift reorder is unavailable, and a drop on the parents/
 * children zones links it to the focused thought instead of flipping a link.
 */
export function wireExternalDragSource(
  el: HTMLElement,
  id: string,
  origin: Exclude<DragOrigin, 'cloud'>,
  opts?: { fromMenu?: boolean },
): void {
  el.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || gesture !== null) return;
    gesture = {
      id,
      dir: undefined,
      origin,
      fromMenu: opts?.fromMenu === true,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      source: el,
      ghost: null,
      lastTarget: null,
    };
    window.addEventListener('mousemove', onCloudMouseMove);
    window.addEventListener('mouseup', onCloudMouseUp);
    window.addEventListener('blur', cancelCloudDrag);
  });
}

function onCloudMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || gesture !== null) return;
  const target = event.target as HTMLElement | null;
  if (target === null) return;
  // Ellipse presses usually run their own gesture (canvas.ts wireEllipseDrag)
  // — it stops propagation, so this listener never sees them. Ctrl+Shift is
  // the zone reorder, and the ellipse handler lets exactly that press through.
  const cloud = target.closest<HTMLElement>('.cloud');
  const id = cloud?.dataset['id'];
  if (cloud === null || id === undefined) return;
  // Zone clouds of the parents/children zones keep their zone semantics
  // (move/reorder between zones); the focus cloud and the siblings zone have
  // no zone of origin and drag like list entries — e.g. to pin them onto the
  // pinned panel or to link them onto another thought (L18).
  const rawDir = cloud.dataset['dir'];
  const dir: OrderableDir | undefined =
    rawDir === 'parents' || rawDir === 'children' ? rawDir : undefined;
  gesture = {
    id,
    dir,
    origin: 'cloud',
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    source: cloud,
    ghost: null,
    lastTarget: null,
  };
  window.addEventListener('mousemove', onCloudMouseMove);
  window.addEventListener('mouseup', onCloudMouseUp);
  window.addEventListener('blur', cancelCloudDrag);
}

function onCloudMouseMove(event: MouseEvent): void {
  if (gesture === null || accessors === null) return;
  if (!gesture.active) {
    const dist = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (dist < DRAG_THRESHOLD_PX) return;
    gesture.active = true;
    document.body.classList.add('cloud-dragging');
    suppressNextCanvasClick();
    gesture.ghost = makeGhost(gesture.source, event.clientX, event.clientY);
    gesture.source.classList.add('drag-source');
  }
  moveGhost(event.clientX, event.clientY);
  const dragged: DraggedCloud = { id: gesture.id, dir: gesture.dir, origin: gesture.origin };
  const target = computeTarget(event, dragged, accessors);
  // A no-op drop inside the dragged's own zone keeps the last target, so the
  // highlight survives pointer passes over the grid gaps between clouds.
  if (!(target.kind === 'none' && target.zoneDir === dragged.dir)) {
    gesture.lastTarget = target;
  }
  highlight(target);
}

function onCloudMouseUp(event: MouseEvent): void {
  const g = gesture;
  if (g === null) return;
  gesture = null;
  window.removeEventListener('mousemove', onCloudMouseMove);
  window.removeEventListener('mouseup', onCloudMouseUp);
  window.removeEventListener('blur', cancelCloudDrag);
  if (!g.active) return; // a plain click — the cloud's own click handler runs
  document.body.classList.remove('cloud-dragging');
  g.source.classList.remove('drag-source');
  g.ghost?.remove();
  const dragged: DraggedCloud = { id: g.id, dir: g.dir, origin: g.origin };
  // The drop applies what the preview showed (the last mousemove target); the
  // fallback covers a drop without any mousemove. Recomputing from the mouseup
  // alone would silently change the drop when a modifier is released a tick
  // before the mouse button.
  const target = g.lastTarget ?? computeTarget(event, dragged, accessors!);
  clearHighlight();
  dropActions.onDragEnd?.();
  // A gesture started on a dropdown row leaves the menu behind — close it now
  // that the drag is over (the row's own click would have done it, but a drop
  // elsewhere produces no click).
  if (g.fromMenu === true) closeMenu();
  switch (target.kind) {
    case 'link-parent':
      void linkToThought(g.id, target.targetThoughtId!, 'parent');
      break;
    case 'link-child':
      void linkToThought(g.id, target.targetThoughtId!, 'child');
      break;
    case 'reparent':
      void reparentThought(g.id, target.targetThoughtId!);
      break;
    case 'move': {
      const dir = target.zoneDir as OrderableDir;
      void moveFocusDirection(g.id, dir);
      break;
    }
    case 'reorder': {
      const dir = target.zoneDir as OrderableDir;
      void reorderZone(g.id, dir, target.insertIndex ?? -1);
      break;
    }
    case 'add-to-selection':
      dropActions.addToSelection?.([g.id]);
      break;
    case 'open-history':
      dropActions.openEntry?.(g.id);
      break;
    case 'pin':
      dropActions.pinThought?.(g.id, target.insertIndex ?? -1);
      break;
    default:
      // A Ctrl+Shift drop that ends in a no-op usually means the zone is not
      // sorted `manual` — say so instead of silently bouncing back. List
      // entries have no zone of origin, so the message never applies to them.
      if (
        g.dir !== undefined &&
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        store.state.zoneSorts[g.dir] !== 'manual'
      ) {
        notice('Упорядочивание работает при сортировке зоны «ручной» (правый клик по зоне → порядок).');
      }
      break;
  }
}

/** Aborts an in-flight drag (e.g. the window lost focus mid-drag). */
function cancelCloudDrag(): void {
  const g = gesture;
  if (g === null) return;
  gesture = null;
  window.removeEventListener('mousemove', onCloudMouseMove);
  window.removeEventListener('mouseup', onCloudMouseUp);
  window.removeEventListener('blur', cancelCloudDrag);
  if (g.fromMenu === true) closeMenu();
  if (g.active) {
    document.body.classList.remove('cloud-dragging');
    g.source.classList.remove('drag-source');
    g.ghost?.remove();
    clearHighlight();
    dropActions.onDragEnd?.();
  }
}

/** A clone of the source cloud, fixed to the viewport, following the cursor. */
function makeGhost(source: HTMLElement, x: number, y: number): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  const rect = source.getBoundingClientRect();
  ghost.style.position = 'fixed';
  // A fixed element without top/left sits at its static (in-flow) position —
  // appended to <body> that is the end of the whole workspace, i.e. below the
  // viewport — and the translate would count from there. Pin the origin to the
  // viewport corner instead, so the transform is cursor-anchored.
  ghost.style.top = '0';
  ghost.style.left = '0';
  ghost.style.width = `${rect.width}px`;
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '1000';
  ghost.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px)`;
  // The cloud sizes come from CSS variables living on the canvas host; the
  // ghost sits on <body>, so copy the resolved values onto it.
  for (const v of ['--cloud-width', '--cloud-gap', '--cloud-font', '--cloud-zoom']) {
    const value = getComputedStyle(source).getPropertyValue(v);
    if (value !== '') ghost.style.setProperty(v, value);
  }
  document.body.append(ghost);
  return ghost;
}

function moveGhost(x: number, y: number): void {
  if (gesture === null || gesture.ghost === null) return;
  const rect = gesture.ghost.getBoundingClientRect();
  gesture.ghost.style.transform = `translate(${x - rect.width / 2}px, ${y - rect.height / 2}px)`;
}

/** Resolves what a drop at the cursor would do (pure DOM read, no side effects). */
function computeTarget(event: MouseEvent, dragged: DraggedCloud, acc: DragAccessors): DropTarget {
  const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  if (el === null) return { kind: 'none' };

  // The pinned panel (L18): a drop pins the dragged thought at the position —
  // between the chips, at the start or at the end. Re-pinning a pinned thought
  // reorders it. Checked first: the pinned dropdown rows share the
  // `.menu-item[data-drag-id]` shape with the history dropdown.
  const pinTarget = dropActions.resolvePinTarget?.(el, event.clientX);
  if (pinTarget !== undefined && pinTarget !== null) {
    return {
      kind: 'pin',
      insertIndex: pinTarget.dropIndex,
      highlightEl: pinTarget.highlightEl,
      highlightCls: 'drop-target-add',
    };
  }

  // Thought list panels are drop targets of their own: the selection panel
  // takes the dragged thought into the selection, the history bar opens it
  // (history dropdown rows are `.menu-item[data-drag-id]` and belong here too).
  // A drop back onto the panel the drag started from is a no-op.
  const selectionList = el.closest<HTMLElement>('.selection-list');
  if (selectionList !== null) {
    if (dragged.origin === 'selection') return { kind: 'none' };
    return { kind: 'add-to-selection', highlightEl: selectionList, highlightCls: 'drop-target-add' };
  }
  const historyBar = el.closest<HTMLElement>('.history-bar, .menu-item[data-drag-id]');
  if (historyBar !== null) {
    if (dragged.origin === 'history') return { kind: 'none' };
    return { kind: 'open-history', highlightEl: historyBar, highlightCls: 'drop-target-add' };
  }

  const cloud = el.closest<HTMLElement>('.cloud');
  if (cloud !== null && cloud.dataset['id'] !== undefined && cloud.dataset['id'] !== dragged.id) {
    const targetThoughtId = cloud.dataset['id'];
    // Ctrl+Shift: manual reorder — insert right before the hovered cloud.
    // Only inside the dragged thought's own zone, and only while it is sorted
    // `manual`; a list entry has no zone, so reorder is unavailable to it.
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
      if (dragged.dir === undefined) return { kind: 'none' };
      return reorderTarget(
        targetThoughtId,
        cloud.closest<HTMLElement>('.zone')?.dataset['dir'],
        dragged,
        acc,
        cloud,
      );
    }
    // Ctrl: move the dragged thought into subordination of the target — any
    // part of the cloud works, the top ellipse included.
    if (event.ctrlKey || event.metaKey) {
      return {
        kind: 'reparent',
        targetThoughtId,
        highlightEl: cloud,
        highlightCls: 'drop-target-link',
      };
    }
    const topEllipse = cloud.querySelector<HTMLElement>('.ellipse-top');
    const overEllipse = el.closest<HTMLElement>('.ellipse');
    if (topEllipse !== null && overEllipse === topEllipse) {
      return {
        kind: 'link-parent',
        targetThoughtId,
        highlightEl: topEllipse,
        highlightCls: 'drop-target-link',
      };
    }
    return { kind: 'link-child', targetThoughtId, highlightEl: cloud, highlightCls: 'drop-target-link' };
  }

  const zone = el.closest<HTMLElement>('.zone');
  if (zone !== null) {
    const zdir = zone.dataset['dir'];
    if (zdir === 'siblings') return { kind: 'none' };
    if (zdir === 'parents' || zdir === 'children') {
      // A plain (or Ctrl) drag never reorders: a drop inside the dragged's own
      // zone is a no-op; a drop on the other zone flips the link direction.
      // A list entry has no zone of its own — the drop links it to the focused
      // thought in the zone's direction (never to itself).
      if (zdir === dragged.dir) return { kind: 'none', zoneDir: zdir };
      if (dragged.id === store.state.focus?.focused.id) return { kind: 'none' };
      return { kind: 'move', zoneDir: zdir, highlightEl: zone, highlightCls: 'drop-target-move' };
    }
  }
  return { kind: 'none' };
}

/** Ctrl+Shift-drop on a thought: insert the dragged thought right before it
 *  (only inside the dragged's own zone and while it is sorted `manual`). */
function reorderTarget(
  targetThoughtId: string,
  zoneDir: string | undefined,
  dragged: DraggedCloud,
  acc: DragAccessors,
  highlightEl: HTMLElement,
): DropTarget {
  const dir = dragged.dir;
  if (dir === undefined) return { kind: 'none' }; // list entries have no zone
  if (zoneDir !== dir) return { kind: 'none' };
  if (store.state.zoneSorts[dir] !== 'manual') return { kind: 'none' };
  return {
    kind: 'reorder',
    zoneDir: dir,
    insertIndex: reorderBeforeIndex(dir, dragged.id, targetThoughtId, acc),
    highlightEl,
    highlightCls: 'drop-target-move',
  };
}

/** Ctrl+Shift-drop on a cloud: insert the dragged thought right before it. */
function reorderBeforeIndex(
  dir: OrderableDir,
  draggedId: string,
  targetId: string,
  acc: DragAccessors,
): number {
  const order = acc.getZoneOrder(dir).filter((x) => x !== draggedId);
  const idx = order.indexOf(targetId);
  return idx >= 0 ? idx : order.length;
}

/** Applies the highlight for the next target, clearing any previous one. */
function highlight(target: DropTarget): void {
  const el = target.highlightEl ?? null;
  if (el === highlighted) return;
  clearHighlight();
  if (el !== null && target.highlightCls !== undefined) {
    el.classList.add(target.highlightCls);
    highlighted = el;
  }
}

function clearHighlight(): void {
  if (highlighted !== null) {
    // `drop-target-add` included: panel targets (selection/history/pinned bar)
    // must release their frame when the drag ends or moves elsewhere — a
    // stuck frame reads as a permanent highlight (L18 fix).
    highlighted.classList.remove('drop-target-link', 'drop-target-move', 'drop-target-add');
    highlighted = null;
  }
}

// ---------------------------------------------------------------------------
// Drop actions
// ---------------------------------------------------------------------------

/** All link entities returned in a grouped view (flattened, deduped by id). */
export function flattenLinks(grouped: ThoughtLinksGrouped): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const push = (link: Link): void => {
    if (!seen.has(link.id)) {
      seen.add(link.id);
      out.push(link);
    }
  };
  for (const group of grouped.by_type) for (const item of group.items) push(item.link);
  for (const item of grouped.untyped_parents) push(item.link);
  for (const item of grouped.untyped_children) push(item.link);
  return out;
}

/** Finds a directed link source→target in a grouped view. */
export function findDirectedLink(
  grouped: ThoughtLinksGrouped,
  sourceId: string,
  targetId: string,
): Link | undefined {
  return flattenLinks(grouped).find((l) => l.source_id === sourceId && l.target_id === targetId);
}

function isDupError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'DUPLICATE';
}

/**
 * Creates a link from the dragged thought onto `targetId` (mode `parent` → dragged
 * is the source; `child` → targetId is the source). Reuses an existing link; if a
 * reverse link exists it is removed and its type carried over (08-ui-spec §2.3.1).
 */
async function linkToThought(draggedId: string, targetId: string, mode: LinkMode): Promise<void> {
  const networkId = requireNetworkId();
  const sourceId = mode === 'parent' ? draggedId : targetId;
  const destId = mode === 'parent' ? targetId : draggedId;
  try {
    const grouped = await etn.links.listByThought(networkId, destId);
    if (findDirectedLink(grouped, sourceId, destId) !== undefined) return; // already linked
    let typeId: string | null = null;
    const reverse = findDirectedLink(grouped, destId, sourceId);
    if (reverse !== undefined) {
      typeId = reverse.type_id;
      const fresh = await etn.links.get(networkId, reverse.id);
      await etn.links.remove(networkId, reverse.id, fresh.version);
    }
    await etn.links.create(networkId, { source_id: sourceId, target_id: destId, type_id: typeId });
    requestZoneAnimation();
    scheduleRefresh();
  } catch (err) {
    if (isDupError(err)) return; // race: link appeared meanwhile — treat as no-op
    noticeErr('Создать связь', err);
  }
}

/**
 * Moves the dragged thought between parents/children by flipping every link it
 * has with the focused thought, preserving each link's type (08-ui-spec §2.3.1).
 * A thought dragged from a list panel may have no link with the focus at all —
 * the drop then creates one in the zone's direction.
 */
async function moveFocusDirection(draggedId: string, toDir: OrderableDir): Promise<void> {
  const networkId = requireNetworkId();
  const focus = store.state.focus;
  if (focus === null) return;
  const focusId = focus.focused.id;
  if (draggedId === focusId) return;
  const both: Array<{ linkId: string; typeId: string | null }> = [
    ...focus.parents.filter((n) => n.id === draggedId),
    ...focus.children.filter((n) => n.id === draggedId),
  ].map((n) => ({ linkId: n.link_id, typeId: n.link_type_id }));
  // New direction: parents → dragged is the source (dragged→focus); children → focus is.
  const [sourceId, targetId] =
    toDir === 'parents' ? [draggedId, focusId] : [focusId, draggedId];
  if (both.length === 0) {
    try {
      await etn.links.create(networkId, { source_id: sourceId, target_id: targetId, type_id: null });
    } catch (err) {
      if (!isDupError(err)) noticeErr('Связать с мыслью в фокусе', err);
    }
  }
  for (const { linkId, typeId } of both) {
    try {
      const fresh = await etn.links.get(networkId, linkId);
      await etn.links.remove(networkId, linkId, fresh.version);
      await etn.links.create(networkId, { source_id: sourceId, target_id: targetId, type_id: typeId });
    } catch (err) {
      if (!isDupError(err)) noticeErr('Переместить мысль', err);
    }
  }
  requestZoneAnimation();
  scheduleRefresh();
}

/**
 * Moves the dragged thought into subordination of `targetId` (Ctrl-drag): every
 * existing parent link of the dragged thought is removed and replaced by a
 * single target→dragged link. The reverse link (dragged→target), if any, is
 * removed first and its type carried over, mirroring {@link linkToThought}.
 */
async function reparentThought(draggedId: string, targetId: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const grouped = await etn.links.listByThought(networkId, draggedId);
    const links = flattenLinks(grouped);
    const existing = links.find((l) => l.source_id === targetId && l.target_id === draggedId);
    const reverse = links.find((l) => l.source_id === draggedId && l.target_id === targetId);
    const toRemove = links.filter(
      (l) => l.target_id === draggedId && (existing === undefined || l.id !== existing.id),
    );
    if (reverse !== undefined) toRemove.push(reverse);
    for (const link of toRemove) {
      try {
        const fresh = await etn.links.get(networkId, link.id);
        await etn.links.remove(networkId, link.id, fresh.version);
      } catch (err) {
        if (!isDupError(err)) noticeErr('Переместить в подчинение', err);
      }
    }
    if (existing === undefined) {
      await etn.links.create(networkId, {
        source_id: targetId,
        target_id: draggedId,
        type_id: reverse?.type_id ?? null,
      });
    }
    requestZoneAnimation();
    scheduleRefresh();
  } catch (err) {
    if (!isDupError(err)) noticeErr('Переместить в подчинение', err);
  }
}

/**
 * Reorders the dragged thought inside its zone — only when the zone is
 * `manual`. The next render shifts the following clouds down one slot and
 * FLIP-animates them to their new positions.
 */
async function reorderZone(draggedId: string, dir: OrderableDir, insertIndex: number): Promise<void> {
  if (store.state.zoneSorts[dir] !== 'manual') return; // bounce back, no change
  const networkId = requireNetworkId();
  const focus = store.state.focus;
  if (focus === null) return;
  const order = store.state.zoneOrder[dir].filter((x) => x !== draggedId);
  const at = Math.max(0, Math.min(order.length, insertIndex));
  order.splice(at, 0, draggedId);
  try {
    await etn.thoughts.setFocusOrder(networkId, focus.focused.id, { dir, ordered_ids: order });
    requestZoneAnimation();
    scheduleRefresh();
  } catch (err) {
    noticeErr('Изменить порядок', err);
  }
}

/** Surfaces a failure as a transient notice. */
function noticeErr(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  notice(`${prefix}: ${msg}`, 'error');
}
