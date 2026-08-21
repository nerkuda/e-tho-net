/**
 * Selection panel (H16, 08-ui-spec.md §5; 09-scenarios.md E).
 *
 * - Ctrl+click toggles a cloud in the selection; Ctrl+click on an ellipse adds
 *   all parents/children of that thought;
 * - panel (left) appears while the selection is non-empty: list of titles plus
 *   a top menu bar with three menus:
 *   - «Выделение» — grow the list (children/parents of everything selected, a
 *     picked thought) and clear it;
 *   - «Действия» — focus-link operations (`link_to_focus`/`unlink_from_focus`,
 *     "focus as the only parent"), export (markdown/pdf/html via the async job
 *     API + polling download) and delete;
 *   - «Свойства» — activity, visual style, type and property values;
 * - group operations go through `thoughts.batch` unless the server API forces
 *   per-entity calls (style, "only parent", property values).
 */

import { scheduleRefresh, requireNetworkId, setFocus } from '../app.js';
import { setAddToSelectionHook, showSelectionThoughtContextMenu } from '../canvas/context-menu.js';
import { applyThoughtIcon, invalidateRef, setSelectionClickHooks } from '../canvas/canvas.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../canvas/add-dialog.js';
import { showThoughtStyleDialog, type ThoughtStylePatch } from '../editor/style-dialog.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { resolveThoughtTypeVisual } from '../lib/type-tree.js';
import { store } from '../state.js';
import { pickLinkType, pickThoughtType, showSelectionPropertiesDialog } from './dialogs.js';
import { THOUGHT_RESOLVE_MAX_IDS, type ExportFormat } from '@etn/shared';

/** Panel chrome the selection module renders into. */
let host: HTMLElement | null = null;
let listHost: HTMLElement | null = null;

/** Mounts the selection panel into the workspace selection host. */
export function mountSelection(selectionHost: HTMLElement): void {
  host = selectionHost;
  host.replaceChildren();

  const header = div('selection-header');
  const title = span('Выделение', 'selection-title');
  const clearButton = button('✕', () => clearSelection(), 'btn small', 'Очистить список');
  header.append(title, clearButton);
  const menuBar = div('selection-menu');
  const menus: Array<[string, () => MenuItem[]]> = [
    ['Выделение', buildSelectionMenu],
    ['Действия', buildActionsMenu],
    ['Свойства', buildPropertiesMenu],
  ];
  for (const [label, build] of menus) {
    const btn = button(label, () => openMenuBelow(btn, build()), 'selection-menu-btn');
    menuBar.append(btn);
  }
  listHost = div('selection-list');
  host.append(header, menuBar, listHost);

  // Ctrl+click wiring (spec §5.1) and list drag-n-drop (§5.5): rows drag onto
  // canvas clouds/zones, and canvas drags can be dropped into the list.
  setAddToSelectionHook((id) => toggleSelection([id]));
  setSelectionClickHooks({
    onCloudClick: (id) => toggleSelection([id]),
    onEllipseClick: (id, direction) => void addNeighborsOf(id, direction),
  });
  registerDropActions({ addToSelection });

  store.subscribe(() => {
    if (host?.isConnected === true) refresh();
  });
  refresh();
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

/** Refreshes the panel visibility and list. */
function refresh(): void {
  if (host === null || listHost === null) return;
  const ids = store.state.selection;
  host.classList.toggle('hidden', ids.length === 0);
  if (ids.length === 0) return;
  const title = host.querySelector('.selection-title');
  if (title !== null) title.textContent = `Выделение (${ids.length})`;
  void renderList(ids);
}

/** Resolves and renders the selection list. */
async function renderList(ids: string[]): Promise<void> {
  if (listHost === null) return;
  const networkId = store.state.networkId;
  if (networkId === null) return;
  listHost.replaceChildren(el('span', 'muted', 'Загрузка…'));
  let refs = new Map<string, import('@etn/shared').ThoughtRef>();
  try {
    // resolve caps at 100 ids per call — chunk long lists (bulk filter
    // commands can push the whole filter result into the selection, L22).
    const resolved: import('@etn/shared').ThoughtRef[] = [];
    for (let i = 0; i < ids.length; i += THOUGHT_RESOLVE_MAX_IDS) {
      const chunk = await etn.thoughts.resolve(networkId, ids.slice(i, i + THOUGHT_RESOLVE_MAX_IDS));
      resolved.push(...chunk);
    }
    refs = new Map(resolved.map((r) => [r.id, r]));
  } catch {
    // ids shown as-is
  }
  listHost.replaceChildren();
  for (const id of ids) {
    const item = div('selection-item');
    // A row drags onto the canvas like a zone cloud (§5.5): link onto a
    // cloud, Ctrl for reparent, drop into parents/children to link to focus.
    wireExternalDragSource(item, id, 'selection');
    const iconBox = span('', 'mini-icon');
    const ref = refs.get(id);
    if (ref !== undefined) {
      applyThoughtIcon(iconBox, ref);
    } else {
      iconBox.textContent = '💭';
    }
    item.append(iconBox);
    const title = el('span', 'sel-title', refs.get(id)?.title ?? id);
    item.append(title);
    const removeBtn = button('✕', () => toggleSelection([id]), 'btn small', 'Убрать из выделения');
    // Keep the row click (focus) from firing alongside the removal.
    removeBtn.addEventListener('click', (event) => event.stopPropagation());
    item.append(removeBtn);
    item.addEventListener('click', () => {
      // Click on the row focuses the thought (canvas + editor repaint); it
      // stays in the selection.
      void setFocus(id).catch(() => undefined);
    });
    // Same context menu as a canvas cloud, minus the selection toggle (§5.1).
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showSelectionThoughtContextMenu(event, {
        id,
        title: refs.get(id)?.title ?? id,
        dir: 'siblings',
      });
    });
    listHost.append(item);
  }
}

/** Toggles the given ids in the selection (adds when missing, else removes). */
export function toggleSelection(ids: string[]): void {
  const current = new Set(store.state.selection);
  let changed = false;
  for (const id of ids) {
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    changed = true;
  }
  if (changed) store.update({ selection: [...current] });
}

/**
 * Adds ids to the selection; duplicates — both against the list already stored
 * and inside the batch itself (a shared parent of several selected thoughts
 * arrives once per thought) — are skipped (08-ui-spec.md §5.1).
 */
export function addToSelection(ids: string[]): void {
  if (ids.length === 0) return;
  const current = new Set(store.state.selection);
  const fresh = [...new Set(ids)].filter((id) => !current.has(id));
  if (fresh.length === 0) return;
  store.update({ selection: [...store.state.selection, ...fresh] });
}

/**
 * Removes the given ids from the selection (bulk filter command «удалить из
 * выделенных», 08-ui-spec.md §15.3): absent ids are ignored, no toggle.
 */
export function removeFromSelection(ids: string[]): void {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  const kept = store.state.selection.filter((id) => !drop.has(id));
  if (kept.length !== store.state.selection.length) store.update({ selection: kept });
}

/** Clears the selection list (the panel hides itself on empty). */
function clearSelection(): void {
  store.update({ selection: [] });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** Opens a menu right below its menu-bar button. */
function openMenuBelow(anchor: HTMLElement, items: MenuItem[]): void {
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom + 2, items);
}

/** «Выделение» menu: grow and clear the selection list. */
function buildSelectionMenu(): MenuItem[] {
  return [
    {
      label: 'Добавить подчиненные мысли',
      onClick: () => void addNeighborsOfAll('children'),
    },
    {
      label: 'Добавить родительские мысли',
      onClick: () => void addNeighborsOfAll('parents'),
    },
    {
      label: 'Добавить мысль…',
      onClick: () => void addPickedThought(),
    },
    MENU_SEPARATOR,
    {
      label: 'Очистить список выделенных мыслей',
      onClick: () => clearSelection(),
    },
  ];
}

/** «Действия» menu: focus links, export, delete. */
function buildActionsMenu(): MenuItem[] {
  const focusId = store.state.focus?.focused.id;
  const needFocus = focusId === undefined;
  return [
    {
      label: 'Добавить мысль в фокусе к родительским…',
      disabled: needFocus,
      onClick: () => void linkFocus('child'),
    },
    {
      label: 'Сделать мысль в фокусе единственным родителем…',
      disabled: needFocus,
      onClick: () => void makeFocusOnlyParent(),
    },
    {
      label: 'Добавить мысль в фокусе к подчиненным…',
      disabled: needFocus,
      onClick: () => void linkFocus('parent'),
    },
    {
      label: 'Исключить мысль в фокусе из родителей',
      disabled: needFocus,
      onClick: () => void unlinkFocus('child'),
    },
    {
      label: 'Исключить мысль в фокусе из подчиненных',
      disabled: needFocus,
      onClick: () => void unlinkFocus('parent'),
    },
    MENU_SEPARATOR,
    {
      label: 'Экспорт',
      submenu: [
        { label: 'Markdown', onClick: () => void runExport('markdown') },
        { label: 'PDF', onClick: () => void runExport('pdf') },
        { label: 'HTML', onClick: () => void runExport('html') },
      ],
    },
    MENU_SEPARATOR,
    {
      label: 'Удалить',
      danger: true,
      onClick: () => void batchDelete(),
    },
  ];
}

/** «Свойства» menu: activity, style, type, property values. */
function buildPropertiesMenu(): MenuItem[] {
  return [
    {
      label: 'Пометить неактуальными',
      onClick: () => void batch({ op: 'set_inactive', args: {} }),
    },
    {
      label: 'Пометить актуальными',
      onClick: () => void batch({ op: 'set_active', args: {} }),
    },
    MENU_SEPARATOR,
    {
      label: 'Изменить настройки…',
      onClick: () => void openStyleDialog(),
    },
    {
      label: 'Изменить тип…',
      onClick: () => void openTypeDialog(),
    },
    {
      label: 'Изменить значение свойства…',
      onClick: () => showSelectionPropertiesDialog(store.state.selection),
    },
  ];
}

// ---------------------------------------------------------------------------
// «Выделение» operations
// ---------------------------------------------------------------------------

/** Adds children/parents of every selected thought to the selection. */
async function addNeighborsOfAll(dir: 'children' | 'parents'): Promise<void> {
  const ids = store.state.selection;
  if (ids.length === 0) return;
  const added: string[] = [];
  for (const id of ids) {
    await collectNeighbors(id, dir, added);
  }
  addToSelection(added);
}

/** Adds children/parents of one thought to the selection (Ctrl+ellipse).
 *  Also used by the structures view tree (L15, 08-ui-spec.md §15.8). */
export async function addNeighborsOf(
  id: string,
  direction: 'parent' | 'child',
): Promise<void> {
  const added: string[] = [];
  await collectNeighbors(id, direction === 'parent' ? 'parents' : 'children', added);
  addToSelection(added);
}

/** Fetches one thought's neighbours into the accumulator. */
async function collectNeighbors(
  id: string,
  dir: 'children' | 'parents',
  out: string[],
): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const neighbors = await etn.thoughts.neighbors(networkId, id, dir, 200);
    for (const neighbor of neighbors) out.push(neighbor.id);
  } catch (err) {
    notice(`Не удалось получить соседей: ${errText(err)}`, 'error');
  }
}

/** Opens the universal thought picker and adds every picked thought. */
async function addPickedThought(): Promise<void> {
  const networkId = requireNetworkId();
  const result = await pickThoughtsDialog({ networkId, allowCreate: false, allowLinkType: false });
  const ids = pickedThoughtIds(result);
  if (ids.length === 0) return;
  addToSelection(ids);
}

// ---------------------------------------------------------------------------
// «Действия» operations
// ---------------------------------------------------------------------------

/**
 * Creates focus↔selection links of the chosen type.
 * `direction: 'child'` makes the focus a parent of every selected thought;
 * `'parent'` makes it their child.
 */
async function linkFocus(direction: 'parent' | 'child'): Promise<void> {
  const focusId = store.state.focus?.focused.id;
  if (focusId === undefined) return;
  const linkTypeId = await pickLinkType('Тип связи с мыслью в фокусе');
  if (linkTypeId === undefined) return;
  await batch({
    op: 'link_to_focus',
    args: { focus_thought_id: focusId, direction, link_type_id: linkTypeId },
  });
}

/**
 * Drops every focus↔selection link of any type.
 * `direction: 'child'` removes focus→selection links (focus out of parents);
 * `'parent'` removes selection→focus links (focus out of children).
 */
async function unlinkFocus(direction: 'parent' | 'child'): Promise<void> {
  const focusId = store.state.focus?.focused.id;
  if (focusId === undefined) return;
  await batch({
    op: 'unlink_from_focus',
    args: { focus_thought_id: focusId, direction },
  });
}

/**
 * Makes the focused thought the only parent of every selected thought: all
 * other incoming links are deleted (with a confirmation), the focus link gets
 * the chosen type.
 */
async function makeFocusOnlyParent(): Promise<void> {
  const focusId = store.state.focus?.focused.id;
  if (focusId === undefined) return;
  const ids = store.state.selection;
  if (ids.length === 0) return;
  const linkTypeId = await pickLinkType('Тип связи с мыслью в фокусе');
  if (linkTypeId === undefined) return;
  const focusTitle = store.state.focus?.focused.title ?? '';
  const confirmed = await confirmDialog(
    'Сделать единственным родителем',
    `У ${ids.length} выделённых мыслей будут удалены все входящие связи, кроме связи с мыслью «${focusTitle}». Продолжить?`,
    true,
  );
  if (!confirmed) return;
  const networkId = requireNetworkId();
  let failed = 0;
  for (const id of ids) {
    try {
      const grouped = await etn.links.listByThought(networkId, id);
      const links = [
        ...grouped.by_type.flatMap((g) => g.items.map((i) => i.link)),
        ...grouped.untyped_parents.map((u) => u.link),
        ...grouped.untyped_children.map((u) => u.link),
      ];
      const incoming = links.filter((l) => l.target_id === id);
      const fromFocus = incoming.filter((l) => l.source_id === focusId);
      for (const link of incoming) {
        if (link.source_id === focusId) continue;
        await etn.links.remove(networkId, link.id, link.version);
      }
      if (fromFocus.length > 0) {
        // Keep exactly one focus link, retyped to the chosen one.
        const [keep, ...extra] = fromFocus;
        for (const link of extra) await etn.links.remove(networkId, link.id, link.version);
        if (keep !== undefined && keep.type_id !== linkTypeId) {
          await etn.links.update(networkId, keep.id, { type_id: linkTypeId }, keep.version);
        }
      } else {
        await etn.links.create(networkId, {
          source_id: focusId,
          target_id: id,
          type_id: linkTypeId,
        });
      }
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) notice(`Не удалось обработать ${failed} мыслей.`, 'error');
  else notice(`Готово: фокус — единственный родитель (${ids.length}).`);
  scheduleRefresh();
}

// ---------------------------------------------------------------------------
// «Свойства» operations
// ---------------------------------------------------------------------------

/**
 * Opens the shared style dialog seeded from the first selected thought
 * (its own colour overrides, else the type's font flags); every change is
 * applied to the whole selection at once.
 */
async function openStyleDialog(): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  let first: import('@etn/shared').ThoughtRef | undefined;
  try {
    const refs = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    first = refs[0];
  } catch {
    // Seed from plain defaults when resolve fails.
  }
  // L21: the type defaults resolve along the ancestor chain; a thought without
  // a type resolves the root type.
  const type = resolveThoughtTypeVisual(
    store.state.thoughtTypes,
    first?.type_id !== undefined && first.type_id !== null ? first.type_id : null,
  );
  showThoughtStyleDialog({
    resolved: {
      fg: first?.fg_color ?? null,
      bg: first?.bg_color ?? null,
      bold: first?.font_bold ?? type.font_bold ?? false,
      italic: first?.font_italic ?? type.font_italic ?? false,
      underline: first?.font_underline ?? type.font_underline ?? false,
      strike: first?.font_strike ?? type.font_strike ?? false,
    },
    onApply: (patch) => applyStyleToAll(patch),
  });
}

/** Applies a style patch to every selected thought (icons are never touched). */
async function applyStyleToAll(patch: ThoughtStylePatch): Promise<boolean> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return false;
  const { icon: _ignored, ...style } = patch;
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const thought = await etn.thoughts.get(networkId, id);
      await etn.thoughts.update(networkId, id, style, thought.version);
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  // No realtime echo to the actor (04-realtime.md §5) — drop the cached refs so
  // the refreshed zones re-resolve the thoughts and repaint their style.
  for (const id of ids) invalidateRef(id);
  scheduleRefresh();
  if (failed > 0) {
    errorDialog('Настройки выделения', `Не удалось применить к ${failed} мыслям.`);
  }
  return failed === 0;
}

/** Opens the searchable type picker and batch-applies the chosen type. */
async function openTypeDialog(): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  // Seed with the type shared by every selected thought (null when mixed).
  let initial: string | null = null;
  try {
    const refs = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    const uniq = new Set(refs.map((r) => r.type_id));
    if (uniq.size === 1) initial = refs[0]?.type_id ?? null;
  } catch {
    // null seed is fine
  }
  const typeId = await pickThoughtType(initial);
  if (typeId === undefined) return;
  if (typeId === null) await batch({ op: 'clear_type', args: {} });
  else await batch({ op: 'set_type', args: { type_id: typeId } });
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

/** Runs a batch operation over the current selection. */
async function batch(input: {
  op: import('@etn/shared').ThoughtBatchOp;
  args: import('@etn/shared').ThoughtBatchArgs;
}): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  try {
    const result = await etn.thoughts.batch(networkId, { ids, op: input.op, args: input.args });
    if (result.failures.length > 0) {
      notice(`Не удалось применить к ${result.failures.length} мыслям.`, 'error');
    } else {
      notice(`Применено к ${result.affected} мыслям.`);
    }
    // The batch can change type/activity — refresh the cached refs so the
    // clouds repaint with the new icon/colours/dim state right away.
    for (const id of ids) invalidateRef(id);
    scheduleRefresh();
  } catch (err) {
    errorDialog('Групповая операция', err);
  }
}

/** Batch delete with confirmation. */
async function batchDelete(): Promise<void> {
  const ids = store.state.selection;
  if (ids.length === 0) return;
  if (!(await confirmDialog('Удалить мысли', `Удалить ${ids.length} мыслей?`, true))) return;
  await batch({ op: 'delete', args: {} });
  store.update({ selection: [] });
}

/** Starts an export job and polls it to completion. */
async function runExport(format: ExportFormat): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  try {
    const { job_id } = await etn.system.export(networkId, { thought_ids: ids, format });
    notice(`Экспорт запущен (${job_id})…`);
    const job = await pollJob(job_id);
    if (job.download_url === undefined) {
      notice('Экспорт завершился без ссылки на скачивание.', 'error');
      return;
    }
    triggerDownload(job.download_url);
    notice('Экспорт готов — файл скачивается.');
  } catch (err) {
    notice(`Экспорт не удался: ${errText(err)}`, 'error');
  }
}

/** Polls the job status until done/failed (max ~60 s). */
async function pollJob(jobId: string): Promise<{ status: string; download_url?: string }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const job = await etn.system.getJob(jobId);
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
  }
  return { status: 'failed' };
}

/** Triggers a browser download for a URL. */
function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
