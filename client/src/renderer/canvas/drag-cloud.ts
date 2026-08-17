/**
 * Canvas cloud drag-n-drop (08-ui-spec.md §2.3.1).
 *
 * A pointer gesture (mousedown → move → mouseup) started from any cloud of the
 * parents/children zones; modifier keys are read live while dragging:
 *
 * - **plain drag** — drop on the top ellipse of cloud Б → create A→Б (A becomes
 *   Б's parent); drop on the body (or bottom ellipse) of cloud Б → create Б→A;
 *   drop on a **different** orderable zone (parents↔children) → flip the
 *   dragged thought's link direction to the focused thought (move); drop
 *   inside the same zone, on the siblings zone or outside any target →
 *   nothing (a plain drag never changes the manual order);
 * - **Ctrl/Cmd drag** — drop on any part of cloud Б → move the dragged thought
 *   into subordination of Б: every existing parent link of the dragged thought
 *   is replaced by a single Б→A link (no copy);
 * - **Alt drag** — reorder inside the dragged thought's zone, only while the
 *   zone is sorted `manual`: a drop on cloud Б puts A right **before** Б. The
 *   insertion point is previewed live — a dashed placeholder opens a gap and
 *   the following clouds shift aside — and the refreshed zone FLIP-animates
 *   the clouds to their final positions.
 *
 * A gesture rather than HTML5 drag-n-drop on purpose: Chromium intercepts
 * Alt+drag ("link selection") and never fires `dragstart`, so modifier-key
 * drags would be impossible. The per-zone ellipse-drag gesture (canvas.ts,
 * `wireEllipseDrag`) is left untouched.
 *
 * Existing links are reused (server 409 → no-op); the reverse link, if any, is
 * removed first and its type carried over to the new link.
 */

import { type Link, type ThoughtLinksGrouped } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { div } from '../lib/dom.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId, scheduleRefresh } from '../app.js';
import { store } from '../state.js';
import { prefersReducedMotion } from './transition.js';
import { DRAG_THRESHOLD_PX, requestZoneAnimation, suppressNextCanvasClick } from './canvas.js';

type OrderableDir = 'parents' | 'children';
type ZoneDir = 'parents' | 'children' | 'siblings';
type LinkMode = 'parent' | 'child';

interface DraggedCloud {
  id: string;
  dir: OrderableDir;
}

type DropKind = 'link-parent' | 'link-child' | 'reparent' | 'move' | 'reorder' | 'none';

interface DropTarget {
  kind: DropKind;
  /** Thought the dragged cloud lands on (link/reparent modes). */
  targetThoughtId?: string;
  /** Zone the drop happens in (move/reorder; on a no-op drop inside the
   *  dragged's own zone it marks the gap so the reorder preview is kept). */
  zoneDir?: ZoneDir;
  /** Insertion index into the zone's order without the dragged id (reorder). */
  insertIndex?: number;
  /** Element to highlight and the class to apply. */
  highlightEl?: HTMLElement;
  highlightCls?: string;
}

/** In-flight pointer drag of a zone cloud. */
interface CloudDragGesture {
  id: string;
  dir: OrderableDir;
  startX: number;
  startY: number;
  active: boolean;
  /** The pressed cloud — dimmed in place while its ghost follows the cursor. */
  source: HTMLElement;
  /** Clone of the source following the cursor (`pointer-events: none`). */
  ghost: HTMLElement | null;
}

/** Accessors into the canvas module (zone element + current manual order). */
export interface DragAccessors {
  getZoneEl: (dir: ZoneDir) => HTMLElement | null;
  /** Full ordered thought-id list of an orderable zone (deduped, display order). */
  getZoneOrder: (dir: OrderableDir) => string[];
}

let gesture: CloudDragGesture | null = null;
let highlighted: HTMLElement | null = null;
/** Reorder preview (Alt-drag): zone and insertion index of the placeholder. */
let previewZone: HTMLElement | null = null;
let previewIndex: number | null = null;
/** Canvas accessors, captured at wiring; the window gesture handlers need them. */
let accessors: DragAccessors | null = null;

/**
 * Wires the cloud drag gesture onto the canvas host: mousedown on a zone cloud
 * starts it; mousemove/mouseup are tracked on the window (like the ellipse
 * gesture) so the drag survives leaving the cloud.
 */
export function wireCloudDrag(host: HTMLElement, acc: DragAccessors): void {
  accessors = acc;
  host.addEventListener('mousedown', (event) => onCloudMouseDown(event));
}

function onCloudMouseDown(event: MouseEvent): void {
  if (event.button !== 0 || gesture !== null) return;
  const target = event.target as HTMLElement | null;
  if (target === null) return;
  // Ellipse presses run their own gesture (canvas.ts) — it stops propagation,
  // so this listener never sees them; the guard is a belt-and-braces.
  if (target.closest<HTMLElement>('.ellipse') !== null) return;
  const cloud = target.closest<HTMLElement>('.cloud');
  const id = cloud?.dataset['id'];
  const dir = cloud?.dataset['dir'];
  if (cloud === null || id === undefined || (dir !== 'parents' && dir !== 'children')) return;
  gesture = {
    id,
    dir,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    source: cloud,
    ghost: null,
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
    document.body.classList.add('dragging');
    suppressNextCanvasClick();
    gesture.ghost = makeGhost(gesture.source, event.clientX, event.clientY);
    gesture.source.classList.add('drag-source');
  }
  moveGhost(event.clientX, event.clientY);
  const dragged: DraggedCloud = { id: gesture.id, dir: gesture.dir };
  const target = computeTarget(event, dragged, accessors);
  highlight(target);
  updateReorderPreview(target, dragged, accessors);
}

function onCloudMouseUp(event: MouseEvent): void {
  const g = gesture;
  if (g === null) return;
  gesture = null;
  window.removeEventListener('mousemove', onCloudMouseMove);
  window.removeEventListener('mouseup', onCloudMouseUp);
  window.removeEventListener('blur', cancelCloudDrag);
  if (!g.active) return; // a plain click — the cloud's own click handler runs
  document.body.classList.remove('dragging');
  g.source.classList.remove('drag-source');
  g.ghost?.remove();
  const dragged: DraggedCloud = { id: g.id, dir: g.dir };
  const target = computeTarget(event, dragged, accessors!);
  clearHighlight();
  switch (target.kind) {
    case 'link-parent':
      removeReorderPreview();
      void linkToThought(g.id, target.targetThoughtId!, 'parent');
      break;
    case 'link-child':
      removeReorderPreview();
      void linkToThought(g.id, target.targetThoughtId!, 'child');
      break;
    case 'reparent':
      removeReorderPreview();
      void reparentThought(g.id, target.targetThoughtId!);
      break;
    case 'move': {
      removeReorderPreview();
      const dir = target.zoneDir as OrderableDir;
      void moveFocusDirection(g.id, dir);
      break;
    }
    case 'reorder': {
      // The placeholder stays in the grid until the refreshed zone re-renders
      // with the new order — the FLIP then animates the clouds into place.
      const dir = target.zoneDir as OrderableDir;
      void reorderZone(g.id, dir, target.insertIndex ?? -1);
      break;
    }
    default:
      removeReorderPreview();
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
  if (g.active) {
    document.body.classList.remove('dragging');
    g.source.classList.remove('drag-source');
    g.ghost?.remove();
    clearHighlight();
  }
  removeReorderPreview();
}

/** A clone of the source cloud, fixed to the viewport, following the cursor. */
function makeGhost(source: HTMLElement, x: number, y: number): HTMLElement {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  const rect = source.getBoundingClientRect();
  ghost.style.position = 'fixed';
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

  const cloud = el.closest<HTMLElement>('.cloud');
  if (cloud !== null && cloud.dataset['id'] !== undefined && cloud.dataset['id'] !== dragged.id) {
    const targetThoughtId = cloud.dataset['id'];
    if (event.altKey) {
      return altReorderTarget(
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

  // The reorder gap itself (Alt-drag preview): a drop on the placeholder means
  // inserting before the cloud right after it.
  const placeholder = el.closest<HTMLElement>('.cloud-drop-placeholder');
  if (placeholder !== null) {
    const nextId = (placeholder.nextElementSibling as HTMLElement | null)?.dataset['id'];
    if (nextId !== undefined && nextId !== dragged.id && event.altKey) {
      return altReorderTarget(
        nextId,
        placeholder.closest<HTMLElement>('.zone')?.dataset['dir'],
        dragged,
        acc,
        placeholder,
      );
    }
    return { kind: 'none' };
  }

  const zone = el.closest<HTMLElement>('.zone');
  if (zone !== null) {
    const zdir = zone.dataset['dir'];
    if (zdir === 'siblings') return { kind: 'none' };
    if (zdir === 'parents' || zdir === 'children') {
      // A plain (or Ctrl) drag never reorders: a drop inside the dragged's own
      // zone is a no-op (the gap keeps the Alt preview alive); a drop on the
      // other zone flips the link direction.
      if (zdir === dragged.dir) return { kind: 'none', zoneDir: zdir };
      return { kind: 'move', zoneDir: zdir, highlightEl: zone, highlightCls: 'drop-target-move' };
    }
  }
  return { kind: 'none' };
}

/** Alt-drop on a thought: insert the dragged thought right before it (only
 *  inside the dragged's own zone and while it is sorted `manual`). */
function altReorderTarget(
  targetThoughtId: string,
  zoneDir: string | undefined,
  dragged: DraggedCloud,
  acc: DragAccessors,
  highlightEl: HTMLElement,
): DropTarget {
  if (zoneDir !== dragged.dir) return { kind: 'none' };
  if (store.state.zoneSorts[dragged.dir] !== 'manual') return { kind: 'none' };
  return {
    kind: 'reorder',
    zoneDir: dragged.dir,
    insertIndex: altCloudIndex(dragged, targetThoughtId, acc),
    highlightEl,
    highlightCls: 'drop-target-move',
  };
}

/** Alt-drop on a cloud: insert the dragged thought right before it. */
function altCloudIndex(dragged: DraggedCloud, targetId: string, acc: DragAccessors): number {
  const order = acc.getZoneOrder(dragged.dir).filter((x) => x !== dragged.id);
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
    highlighted.classList.remove('drop-target-link', 'drop-target-move');
    highlighted = null;
  }
}

// ---------------------------------------------------------------------------
// Reorder preview (Alt-drag): a dashed placeholder opens a gap at the
// insertion point and the following clouds shift aside (mini-FLIP). The
// placeholder stays until the zone re-renders with the new order, so the
// refresh-time FLIP animates the dragged cloud into the gap.
// ---------------------------------------------------------------------------

function updateReorderPreview(target: DropTarget, dragged: DraggedCloud, acc: DragAccessors): void {
  if (target.kind !== 'reorder' || target.zoneDir === undefined || target.insertIndex === undefined) {
    // Hovering the gaps inside the dragged's own zone keeps the preview at its
    // last index; anything else dismisses it.
    if (!(target.kind === 'none' && target.zoneDir === dragged.dir)) {
      removeReorderPreview();
    }
    return;
  }
  const zone = acc.getZoneEl(target.zoneDir);
  if (zone === null) {
    removeReorderPreview();
    return;
  }
  const index = target.insertIndex;
  if (
    previewZone === zone &&
    previewIndex === index &&
    zone.querySelector('.cloud-drop-placeholder') !== null
  ) {
    return;
  }
  removeReorderPreview();
  previewZone = zone;
  previewIndex = index;
  const grid = zone.querySelector<HTMLElement>('.zone-grid');
  const source = gesture?.source ?? null;
  if (grid === null || source === null) return;

  // Grid position among the rendered (visible-window) clouds: before the first
  // cloud whose full-order index is >= the insertion index.
  const order = acc.getZoneOrder(dragged.dir).filter((x) => x !== dragged.id);
  const children = Array.from(grid.children);
  let pos = children.length;
  for (let i = 0; i < children.length; i++) {
    const id = (children[i] as HTMLElement).dataset['id'];
    if (id !== undefined && order.indexOf(id) >= index) {
      pos = i;
      break;
    }
  }

  // Mini-FLIP: the clouds from the insertion point on shift aside.
  const before =
    prefersReducedMotion() ? null : new Map<HTMLElement, DOMRect>();
  if (before !== null) {
    for (let i = pos; i < children.length; i++) {
      const el = children[i] as HTMLElement;
      before.set(el, el.getBoundingClientRect());
    }
  }
  const placeholder = div('cloud-drop-placeholder');
  placeholder.style.height = `${source.getBoundingClientRect().height}px`;
  grid.insertBefore(placeholder, children[pos] ?? null);
  if (before !== null) playShift(before);
}

function removeReorderPreview(): void {
  previewZone?.querySelector('.cloud-drop-placeholder')?.remove();
  previewZone = null;
  previewIndex = null;
}

/** Glides shifted clouds from their old rects to the placeholder gap. */
function playShift(before: Map<HTMLElement, DOMRect>): void {
  for (const [el, oldRect] of before) {
    const rect = el.getBoundingClientRect();
    const dx = oldRect.left - rect.left;
    const dy = oldRect.top - rect.top;
    if (Math.abs(dx) + Math.abs(dy) < 1) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 180, easing: 'ease-out' },
    );
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
 */
async function moveFocusDirection(draggedId: string, toDir: OrderableDir): Promise<void> {
  const networkId = requireNetworkId();
  const focus = store.state.focus;
  if (focus === null) return;
  const focusId = focus.focused.id;
  const both: Array<{ linkId: string; typeId: string | null }> = [
    ...focus.parents.filter((n) => n.id === draggedId),
    ...focus.children.filter((n) => n.id === draggedId),
  ].map((n) => ({ linkId: n.link_id, typeId: n.link_type_id }));
  // New direction: parents → dragged is the source (dragged→focus); children → focus is.
  const [sourceId, targetId] =
    toDir === 'parents' ? [draggedId, focusId] : [focusId, draggedId];
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
 * `manual`. The next render FLIP-animates the clouds to their new positions;
 * the reorder preview placeholder is kept in the grid until then.
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
    removeReorderPreview();
    noticeErr('Изменить порядок', err);
  }
}

/** Surfaces a failure as a transient notice. */
function noticeErr(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  notice(`${prefix}: ${msg}`, 'error');
}
