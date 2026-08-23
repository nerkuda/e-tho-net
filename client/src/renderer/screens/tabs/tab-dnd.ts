/**
 * Drag-reorder for visible tabs (08-ui-spec.md §1.1, workplan Q3).
 *
 * Reuses the pointer-gesture pattern from `canvas/drag-cloud.ts`:
 *  - `mousedown` on a tab button → start tracking;
 *  - `mousemove` on `window` → move a ghost clone and detect hover targets;
 *  - `mouseup` on `window` → commit (call `onReorder` with the new id order).
 *
 * Only **visible** tabs (`.tab:not([hidden])`) participate. The "+" and the
 * overflow button are never drag sources or drop targets.
 */
const DRAG_THRESHOLD_PX = 6;

interface DragState {
  startX: number;
  startY: number;
  active: boolean;
  source: HTMLButtonElement;
  ghost: HTMLDivElement;
  root: HTMLElement;
  onReorder: (orderedIds: string[]) => void;
}

interface WiredRoot extends HTMLElement {
  __tabReorder?: (orderedIds: string[]) => void;
}

/** Active drag state (singleton — one drag at a time, like drag-cloud). */
let drag: DragState | null = null;

/**
 * Wires the drag-reorder on `root`. Idempotent: subsequent calls clear the
 * previous wiring first to avoid stacking listeners across re-renders.
 */
export function wireTabDrag(root: HTMLElement, onReorder: (orderedIds: string[]) => void): void {
  const wired = root as WiredRoot;
  wired.__tabReorder = onReorder;
  root.removeEventListener('mousedown', onMouseDown);
  root.addEventListener('mousedown', onMouseDown);
}

function onMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target === null) return;
  // Walk up to the closest .tab — the close button stops propagation so we
  // never get here from clicks on the "✕".
  const source = target.closest<HTMLButtonElement>('.tab');
  if (source === null) return;
  if (source.classList.contains('tab-plus')) return;
  if (source.hidden) return;
  const root = source.parentElement;
  if (root === null) return;

  const wired = root as WiredRoot;
  if (wired.__tabReorder === undefined) return;

  drag = {
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    source,
    ghost: null as unknown as HTMLDivElement,
    root,
    onReorder: wired.__tabReorder,
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', cancelDrag);
}

function onMouseMove(event: MouseEvent): void {
  if (drag === null) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.active = true;
    drag.ghost = createGhost(drag.source, event.clientX, event.clientY);
    document.body.append(drag.ghost);
    drag.source.classList.add('tab-dragging');
  }
  drag.ghost.style.left = `${event.clientX}px`;
  drag.ghost.style.top = `${event.clientY}px`;

  // Detect target tab (visible only) and shift its position.
  const target = findDropTarget(drag.root, event.clientX, event.clientY, drag.source);
  if (target !== null) {
    const rect = target.getBoundingClientRect();
    const before = event.clientX < rect.left + rect.width / 2;
    if (before) {
      drag.root.insertBefore(drag.source, target);
    } else {
      drag.root.insertBefore(drag.source, target.nextSibling);
    }
  }
}

function onMouseUp(): void {
  if (drag === null) return;
  const root = drag.root;
  const onReorder = drag.onReorder;
  const wasActive = drag.active;
  teardown();
  if (!wasActive) return; // never started → treat as a click
  onReorder(collectOrder(root));
}

function teardown(): void {
  if (drag !== null) {
    if (drag.ghost !== null) drag.ghost.remove();
    drag.source.classList.remove('tab-dragging');
  }
  drag = null;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  window.removeEventListener('blur', cancelDrag);
}

function cancelDrag(): void {
  if (drag === null) return;
  // Restore original DOM order isn't easy without snapshot; refresh from main.
  teardown();
}

/** Returns the visible tab under the cursor, excluding `source` itself. */
function findDropTarget(
  root: HTMLElement,
  x: number,
  y: number,
  source: HTMLButtonElement,
): HTMLButtonElement | null {
  // elementsFromPoint so we ignore the ghost layer (which is `pointer-events:none`).
  const els = document.elementsFromPoint(x, y);
  for (const candidate of els) {
    if (candidate === source || candidate.contains(source)) continue;
    if (!(candidate instanceof HTMLButtonElement)) continue;
    if (!candidate.classList.contains('tab')) continue;
    if (candidate.classList.contains('tab-plus')) continue;
    if (candidate.hidden) continue;
    if (!root.contains(candidate)) continue;
    return candidate;
  }
  return null;
}

/** Reads the visible tab order (excluding "+" and overflow). */
function collectOrder(root: HTMLElement): string[] {
  const ids: string[] = [];
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLButtonElement)) continue;
    if (!child.classList.contains('tab')) continue;
    if (child.classList.contains('tab-plus')) continue;
    if (child.hidden) continue;
    const id = child.dataset['tabId'];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function createGhost(source: HTMLButtonElement, x: number, y: number): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.className = 'tab-ghost';
  ghost.textContent = source.textContent ?? '';
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
  ghost.style.position = 'fixed';
  ghost.style.pointerEvents = 'none';
  return ghost;
}
