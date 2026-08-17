/**
 * Canvas cloud drag-n-drop (08-ui-spec.md §2.3/§2.7).
 *
 * A single model driven off one custom MIME type ({@link CLOUD_DRAG_MIME}) so an
 * internal cloud drag is never confused with an external file/URL drop:
 *
 * - **plain drag** — drop on the top ellipse of cloud Б → create A→Б (A becomes
 *   Б's parent); drop on the body (or bottom ellipse) of cloud Б → create Б→A;
 *   drop on a **different** orderable zone (parents↔children) → flip the dragged
 *   thought's link direction to the focused thought (move); drop **inside the
 *   same** zone, on the siblings zone or outside any target → nothing (the
 *   manual order is never changed by a plain drag);
 * - **Ctrl/Cmd drag** — drop on any part of cloud Б → move the dragged thought
 *   into subordination of Б: every existing parent link of the dragged thought
 *   is replaced by a single Б→A link (no copy);
 * - **Alt drag** — reorder inside the dragged thought's zone, only while the
 *   zone is sorted `manual`: drop on cloud Б → A takes the position right
 *   before Б; drop on the empty top part of the zone → first; on the empty
 *   bottom part → last.
 *
 * Existing links are reused (server 409 → no-op); the reverse link, if any, is
 * removed first and its type carried over to the new link. The per-zone
 * ellipse-drag gesture (`wireEllipseDrag`) is left untouched.
 */

import { CLOUD_DRAG_MIME, type Link, type ThoughtLinksGrouped } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId, scheduleRefresh } from '../app.js';
import { store } from '../state.js';
import { requestZoneAnimation } from './canvas.js';

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
  /** Zone the drop happens in (move/reorder). */
  zoneDir?: ZoneDir;
  /** Insertion index into the zone's order without the dragged id (reorder). */
  insertIndex?: number;
  /** Element to highlight and the class to apply. */
  highlightEl?: HTMLElement;
  highlightCls?: string;
}

/** Accessors into the canvas module (zone element + current manual order). */
export interface DragAccessors {
  getZoneEl: (dir: ZoneDir) => HTMLElement | null;
  /** Full ordered thought-id list of an orderable zone (deduped, display order). */
  getZoneOrder: (dir: OrderableDir) => string[];
}

let currentDragged: DraggedCloud | null = null;
let highlighted: HTMLElement | null = null;

/**
 * Wires the cloud drag model onto the canvas host. One delegation point for
 * `dragstart`/`dragover`/`drop`/`dragend`; per-cloud `draggable` is set elsewhere.
 */
export function wireCloudDrag(host: HTMLElement, acc: DragAccessors): void {
  host.addEventListener('dragstart', (event) => onDragStart(event));
  host.addEventListener('dragover', (event) => onDragOver(event, acc));
  host.addEventListener('drop', (event) => onDrop(event, acc));
  host.addEventListener('dragend', resetDrag);
}

/** Clears highlight and the in-flight drag state (fires after every drag). */
function resetDrag(): void {
  clearHighlight();
  currentDragged = null;
}

/** True when the in-flight drag carries the internal cloud MIME type. */
function isCloudDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(CLOUD_DRAG_MIME) ?? false;
}

function onDragStart(event: DragEvent): void {
  const cloud = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cloud');
  if (cloud === null || cloud === undefined) return;
  const id = cloud.dataset['id'];
  const zone = cloud.closest<HTMLElement>('.zone');
  const dir = zone?.dataset['dir'];
  if (id === undefined || (dir !== 'parents' && dir !== 'children')) return;
  currentDragged = { id, dir };
  const transfer = event.dataTransfer;
  if (transfer !== null) {
    const payload = `${dir}:${id}`;
    transfer.setData(CLOUD_DRAG_MIME, payload);
    transfer.setData('text/plain', payload);
    transfer.effectAllowed = 'move';
  }
}

/** Resolves what a drop at the cursor would do (pure DOM read, no side effects). */
function computeTarget(event: DragEvent, dragged: DraggedCloud, acc: DragAccessors): DropTarget {
  const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  if (el === null) return { kind: 'none' };

  const cloud = el.closest<HTMLElement>('.cloud');
  if (cloud !== null && cloud.dataset['id'] !== undefined && cloud.dataset['id'] !== dragged.id) {
    const targetThoughtId = cloud.dataset['id'];
    // Alt: manual reorder — insert right before the hovered cloud. Only inside
    // the dragged thought's own zone, and only while it is sorted `manual`.
    if (event.altKey) {
      if (cloud.closest<HTMLElement>('.zone')?.dataset['dir'] !== dragged.dir) {
        return { kind: 'none' };
      }
      if (store.state.zoneSorts[dragged.dir] !== 'manual') return { kind: 'none' };
      return {
        kind: 'reorder',
        zoneDir: dragged.dir,
        insertIndex: altCloudIndex(dragged, targetThoughtId, acc),
        highlightEl: cloud,
        highlightCls: 'drop-target-move',
      };
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
      // Alt: drop on the zone's empty area — top part → first, bottom → last.
      if (event.altKey) {
        if (zdir !== dragged.dir || store.state.zoneSorts[dragged.dir] !== 'manual') {
          return { kind: 'none' };
        }
        return {
          kind: 'reorder',
          zoneDir: zdir,
          insertIndex: altZoneIndex(zone, event, dragged, acc),
          highlightEl: zone,
          highlightCls: 'drop-target-move',
        };
      }
      // Plain (and Ctrl) drags never reorder: a drop inside the dragged's own
      // zone is a no-op; a drop on the other zone flips the link direction.
      if (zdir === dragged.dir) return { kind: 'none' };
      return { kind: 'move', zoneDir: zdir, highlightEl: zone, highlightCls: 'drop-target-move' };
    }
  }
  return { kind: 'none' };
}

/** Alt-drop on a cloud: insert the dragged thought right before it. */
function altCloudIndex(dragged: DraggedCloud, targetId: string, acc: DragAccessors): number {
  const order = acc.getZoneOrder(dragged.dir).filter((x) => x !== dragged.id);
  const idx = order.indexOf(targetId);
  return idx >= 0 ? idx : order.length;
}

/**
 * Alt-drop on the zone's empty area: above the first visible cloud → first,
 * below the last → last, between rows → before the row below the cursor.
 */
function altZoneIndex(
  zone: HTMLElement,
  event: DragEvent,
  dragged: DraggedCloud,
  acc: DragAccessors,
): number {
  const order = acc.getZoneOrder(dragged.dir).filter((x) => x !== dragged.id);
  const y = event.clientY;
  for (const cloud of zone.querySelectorAll<HTMLElement>('.cloud[data-id]')) {
    const id = cloud.dataset['id'];
    if (id === undefined || !order.includes(id)) continue;
    const rect = cloud.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return order.indexOf(id);
  }
  if (order.length === 0) {
    const rect = zone.getBoundingClientRect();
    return y < rect.top + rect.height / 2 ? 0 : order.length;
  }
  return order.length;
}

function onDragOver(event: DragEvent, acc: DragAccessors): void {
  if (currentDragged === null || !isCloudDrag(event)) return;
  const target = computeTarget(event, currentDragged, acc);
  highlight(target);
  if (target.kind === 'none') return;
  event.preventDefault();
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = 'move';
  }
}

function onDrop(event: DragEvent, acc: DragAccessors): void {
  if (currentDragged === null || !isCloudDrag(event)) return;
  const dragged = currentDragged;
  const target = computeTarget(event, dragged, acc);
  clearHighlight();
  if (target.kind === 'none') return;
  event.preventDefault();
  switch (target.kind) {
    case 'link-parent':
      void linkToThought(dragged.id, target.targetThoughtId!, 'parent');
      break;
    case 'link-child':
      void linkToThought(dragged.id, target.targetThoughtId!, 'child');
      break;
    case 'reparent':
      void reparentThought(dragged.id, target.targetThoughtId!);
      break;
    case 'move': {
      const dir = target.zoneDir as OrderableDir;
      void moveFocusDirection(dragged.id, dir);
      break;
    }
    case 'reorder': {
      const dir = target.zoneDir as OrderableDir;
      void reorderZone(dragged.id, dir, target.insertIndex ?? -1);
      break;
    }
    default:
      break;
  }
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
 * reverse link exists it is removed and its type carried over (08-ui-spec §3/§4).
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
 * has with the focused thought, preserving each link's type (08-ui-spec §1).
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

/** Reorders the dragged thought inside its zone — only when the zone is `manual`. */
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
