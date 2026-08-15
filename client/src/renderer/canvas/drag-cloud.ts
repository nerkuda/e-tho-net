/**
 * Canvas cloud drag-n-drop (08-ui-spec.md §2.6/§2.7, scenarios §3).
 *
 * Replaces the old reorder-only wiring with a single model driven off one custom
 * MIME type ({@link CLOUD_DRAG_MIME}) so an internal cloud drag is never confused
 * with an external file/URL drop:
 *
 * - drop on the **top ellipse** of cloud Б → create A→Б (A becomes Б's parent);
 * - drop on the **body** (or bottom ellipse) of cloud Б → create Б→A;
 * - drop on a **different** orderable zone (parents↔children) → flip the dragged
 *   thought's link direction to the focused thought (move);
 * - drop **inside the same** zone, when it is sorted `manual`, → reorder;
 * - drop on the **siblings** zone or outside any target → nothing;
 * - with **Ctrl/Cmd** held → copy the thought ("Копия: …") and apply the same
 *   linking rule to the copy.
 *
 * Existing links are reused (server 409 → no-op); the reverse link, if any, is
 * removed first and its type carried over to the new link. The previous
 * per-zone ellipse-drag gesture (`wireEllipseDrag`) is left untouched.
 */

import { CLOUD_DRAG_MIME, type Attachment, type Link, type ThoughtLinksGrouped } from '@etn/shared';

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

type DropKind = 'link-parent' | 'link-child' | 'move' | 'reorder' | 'none';

interface DropTarget {
  kind: DropKind;
  /** Thought the dragged cloud lands on (link modes). */
  targetThoughtId?: string;
  /** Zone the drop happens in (move/reorder). */
  zoneDir?: ZoneDir;
  /** Insertion index into the zone's order without the dragged id (reorder). */
  insertIndex?: number;
  /** Element to highlight and the class to apply. */
  highlightEl?: HTMLElement;
  highlightCls?: string;
}

/** Copy destination: either dock into a zone (link to the focus) or onto a thought. */
type CopyDest =
  | { kind: 'zone'; dir: OrderableDir }
  | { kind: 'link'; targetId: string; mode: LinkMode };

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
    transfer.effectAllowed = 'copyMove';
  }
}

/** Resolves what a drop at the cursor would do (pure DOM read, no side effects). */
function computeTarget(event: DragEvent, dragged: DraggedCloud, acc: DragAccessors): DropTarget {
  const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  if (el === null) return { kind: 'none' };

  const cloud = el.closest<HTMLElement>('.cloud');
  if (cloud !== null && cloud.dataset['id'] !== undefined && cloud.dataset['id'] !== dragged.id) {
    const targetThoughtId = cloud.dataset['id'];
    const topEllipse = cloud.querySelector<HTMLElement>('.ellipse');
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
      if (zdir === dragged.dir) {
        return {
          kind: 'reorder',
          zoneDir: zdir,
          insertIndex: computeInsertIndex(zdir, el, event, acc),
          highlightEl: zone,
          highlightCls: 'drop-target-move',
        };
      }
      return { kind: 'move', zoneDir: zdir, highlightEl: zone, highlightCls: 'drop-target-move' };
    }
  }
  return { kind: 'none' };
}

/** Index in the zone order (without the dragged id) where the drop would insert. */
function computeInsertIndex(
  dir: OrderableDir,
  hovered: HTMLElement,
  event: DragEvent,
  acc: DragAccessors,
): number {
  const order = acc.getZoneOrder(dir).filter((x) => x !== currentDragged?.id);
  const cloud = hovered.closest<HTMLElement>('.cloud');
  const id = cloud?.dataset['id'];
  if (cloud !== null && id !== undefined) {
    const idx = order.indexOf(id);
    if (idx >= 0) {
      const rect = cloud.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2 ? idx : idx + 1;
    }
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
    event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move';
  }
}

function onDrop(event: DragEvent, acc: DragAccessors): void {
  if (currentDragged === null || !isCloudDrag(event)) return;
  const dragged = currentDragged;
  const target = computeTarget(event, dragged, acc);
  clearHighlight();
  if (target.kind === 'none') return;
  event.preventDefault();
  const copy = event.ctrlKey || event.metaKey;
  switch (target.kind) {
    case 'link-parent':
      void (copy
        ? copyThought(dragged, { kind: 'link', targetId: target.targetThoughtId!, mode: 'parent' })
        : linkToThought(dragged.id, target.targetThoughtId!, 'parent'));
      break;
    case 'link-child':
      void (copy
        ? copyThought(dragged, { kind: 'link', targetId: target.targetThoughtId!, mode: 'child' })
        : linkToThought(dragged.id, target.targetThoughtId!, 'child'));
      break;
    case 'move': {
      const dir = target.zoneDir as OrderableDir;
      void (copy ? copyThought(dragged, { kind: 'zone', dir }) : moveFocusDirection(dragged.id, dir));
      break;
    }
    case 'reorder': {
      const dir = target.zoneDir as OrderableDir;
      void (copy
        ? copyThought(dragged, { kind: 'zone', dir })
        : reorderZone(dragged.id, dir, target.insertIndex ?? -1));
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

/**
 * Copies the dragged thought ("Копия: …") — visual fields + permanent comment +
 * attachments, no links or chronological comments — then links the copy per the
 * drop destination (08-ui-spec §7).
 */
async function copyThought(dragged: DraggedCloud, dest: CopyDest): Promise<void> {
  const networkId = requireNetworkId();
  const focusId = store.state.focus?.focused.id ?? null;
  try {
    const orig = await etn.thoughts.get(networkId, dragged.id);

    // Resolve the create_link for the copy. A drop onto the siblings zone (no
    // thought) is not allowed for copies — bail out.
    let createLink: { direction: LinkMode; target_thought_id: string } | undefined;
    if (dest.kind === 'zone') {
      if (focusId === null) return;
      createLink = { direction: dest.dir === 'parents' ? 'parent' : 'child', target_thought_id: focusId };
    } else {
      createLink = { direction: dest.mode, target_thought_id: dest.targetId };
    }

    const copy = await etn.thoughts.create(networkId, {
      title: `Копия: ${orig.title}`,
      synonyms: orig.synonyms,
      type_id: orig.type_id,
      icon: orig.icon,
      icon_kind: orig.icon_kind,
      active: orig.active,
      fg_color: orig.fg_color,
      bg_color: orig.bg_color,
      font_bold: orig.font_bold ?? undefined,
      font_italic: orig.font_italic ?? undefined,
      font_underline: orig.font_underline ?? undefined,
      font_strike: orig.font_strike ?? undefined,
      create_link: createLink,
    }).catch(async (err: unknown) => {
      // The link may already exist (409 DUPLICATE) — fall back to a bare copy.
      if (isDupError(err)) {
        return etn.thoughts.create(networkId, {
          title: `Копия: ${orig.title}`,
          synonyms: orig.synonyms,
          type_id: orig.type_id,
          icon: orig.icon,
          icon_kind: orig.icon_kind,
          active: orig.active,
          fg_color: orig.fg_color,
          bg_color: orig.bg_color,
          font_bold: orig.font_bold ?? undefined,
          font_italic: orig.font_italic ?? undefined,
          font_underline: orig.font_underline ?? undefined,
          font_strike: orig.font_strike ?? undefined,
        });
      }
      throw err;
    });

    // Permanent comment (at most one) — chronological comments are not copied.
    const comments = await etn.comments.list(networkId, 'thought', dragged.id);
    const perm = comments.find((c) => c.kind === 'permanent');
    if (perm !== undefined) {
      await etn.comments.create(networkId, 'thought', copy.id, {
        kind: 'permanent',
        body_md: perm.body_md,
      });
    }

    // Attachments (paths/URLs are copied by reference on MVP).
    const attachments = await etn.attachments.list(networkId, 'thought', dragged.id);
    for (const att of attachments) {
      await etn.attachments.add(networkId, 'thought', copy.id, attachmentToInput(att));
    }

    scheduleRefresh();
  } catch (err) {
    noticeErr('Скопировать мысль', err);
  }
}

/** Maps a stored attachment back to its create input. */
function attachmentToInput(att: Attachment): {
  kind: 'url' | 'file';
  url?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  title?: string | null;
  description?: string | null;
} {
  return {
    kind: att.kind,
    url: att.url,
    file_path: att.file_path,
    file_size: att.file_size,
    mime_type: att.mime_type,
    title: att.title,
    description: att.description,
  };
}

/** Surfaces a failure as a transient notice. */
function noticeErr(prefix: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  notice(`${prefix}: ${msg}`, 'error');
}
