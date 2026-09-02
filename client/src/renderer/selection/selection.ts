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
import {
  setAddToSelectionHook,
  showSelectionThoughtContextMenu,
} from '../canvas/context-menu.js';
import { buildMultiThoughtSnapshot, type SnapshotDeps } from '../canvas/clipboard.js';
import { applyThoughtIcon, getRef, invalidateRef, setSelectionClickHooks } from '../canvas/canvas.js';
import { registerDropActions, wireExternalDragSource } from '../canvas/drag-cloud.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../canvas/add-dialog.js';
import { showThoughtStyleDialog, type ThoughtStylePatch } from '../editor/style-dialog.js';
import { showExportEtnxDialog } from '../import-export/export-dialog.js';
import { showImportEtnxDialog } from '../import-export/import-dialog.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { markThoughtCommentPreview } from '../lib/hover-preview.js';
import { svgIcon } from '../lib/icons.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { resolveThoughtTypeVisual } from '../lib/type-tree.js';
import { store } from '../state.js';
import { pickLinkType, pickThoughtType, showSelectionPropertiesDialog } from './dialogs.js';
import { openThoughtDeleteDialog, openThoughtGroupDeleteDialog } from '../trash.js';
import { THOUGHT_RESOLVE_MAX_IDS, type ExportEtnxOptions, type ExportFormat, type ExportRequest } from '@etn/shared';

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

/**
 * Forces a selection-list re-render (S13): the rows re-resolve their refs, so
 * thoughts that just moved to/from the trash repaint their marks. Called after
 * the group-delete dialog applies its batch — the panel stays open with the
 * same contents, only the per-row state (trash mark) may change.
 */
export function refreshSelectionPanel(): void {
  if (host?.isConnected === true) refresh();
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
    // A thought in the trash (S13, §5a.2): the row shows the red trash mark
    // next to the title and dims — the same "marked" reading as the canvas
    // badge, scaled down to the list.
    if (ref?.marked_for_deletion === true) {
      item.classList.add('dim');
      const mark = span('', 'list-trash-mark');
      mark.append(svgIcon('trash', 12));
      item.append(mark);
    }
    const title = el('span', 'sel-title', refs.get(id)?.title ?? id);
    item.append(title);
    // Stage 3: no per-indicator icons in the selection list — Ctrl+hover on
    // the row shows the thought's permanent comment.
    markThoughtCommentPreview(item, id, refs.get(id)?.title ?? id);
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
  const hasSelection = store.state.selection.length > 0;
  return [
    {
      label: 'Скопировать мысли',
      disabled: !hasSelection,
      onClick: () => void copySelection(),
    },
    MENU_SEPARATOR,
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
        { label: 'zip-архив (.etnx)…', onClick: () => void runExport('etnx') },
        { label: 'Markdown', onClick: () => void runExport('markdown') },
        { label: 'PDF', onClick: () => void runExport('pdf') },
        { label: 'HTML', onClick: () => void runExport('html') },
      ],
    },
    {
      label: 'Импорт…',
      onClick: () => void runImport(),
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
      label: 'Изменить тип мыслей…',
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
 * Captures every thought in the current selection into the clipboard
 * (workplan L26). The snapshot includes each thought's permanent comment,
 * property values and attachments, plus the inter-thought links that live
 * entirely inside the selection.
 *
 * Called only by the «Скопировать мысли» item of the panel's «Действия»
 * menu — deliberately NOT wired to any hotkey (bug 627a0822): Ctrl+C always
 * copies the clicked/focused thought, never the panel's contents.
 */
export async function copySelection(): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  try {
    // Resolve lightweight metadata first to know each thought's type_id (so
    // we can later look up the source property keys).
    const refs = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    // Fetch full Thought rows in parallel — `get` returns the style and
    // type_id we need for the snapshot.
    const thoughts = await Promise.all(
      refs.map(async (r) => etn.thoughts.get(networkId, r.id).catch(() => null)),
    );
    const valid = thoughts.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length === 0) {
      notice('Не удалось получить мысли для копирования.', 'error');
      return;
    }
    const deps = makeSelectionSnapshotDeps(networkId);
    await buildMultiThoughtSnapshot(valid, deps);
    notice(`Скопировано ${valid.length} ${pluraliseThoughtsRu(valid.length)}.`);
  } catch (err) {
    notice(`Не удалось скопировать: ${errText(err)}`, 'error');
  }
}

function pluraliseThoughtsRu(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'мысль';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'мысли';
  return 'мыслей';
}

/** Build a SnapshotDeps bound to the selection panel / current network.
 *  Exported so the global Ctrl+C handler in `app.ts` can build the same
 *  snapshot when the user copies the focused thought via keyboard. */
export function makeSelectionSnapshotDeps(networkId: string): SnapshotDeps {
  const typeNames = new Map<string | null, string | null>();
  for (const t of store.state.thoughtTypes) {
    typeNames.set(t.id, t.name);
  }
  const linkTypeNames = new Map<
    string | null,
    { name_forward: string | null; name_reverse: string | null }
  >();
  for (const t of store.state.linkTypes) {
    linkTypeNames.set(t.id, { name_forward: t.name_forward, name_reverse: t.name_reverse });
  }
  const sourceName = store.state.networkList.find((n) => n.id === networkId)?.display_name;

  // Same property-key cache the context menu uses — the PropertyValue DTO
  // carries only the id, so we resolve the key through the type's effective
  // property list (cached per type_id).
  const propertyKeyCache = new Map<string, string>();
  async function resolvePropertyKeys(thought: {
    type_id: string | null;
  }): Promise<Map<string, string>> {
    if (thought.type_id === null) return new Map();
    const cached = propertyKeyCache.get(thought.type_id);
    if (cached !== undefined)
      return new Map(Object.entries(JSON.parse(cached) as Record<string, string>));
    try {
      const defs = await etn.types.listTypeProperties(networkId, 'thought_type', thought.type_id);
      const map = new Map<string, string>();
      for (const def of defs) map.set(def.id, def.key);
      propertyKeyCache.set(thought.type_id, JSON.stringify(Object.fromEntries(map)));
      return map;
    } catch {
      return new Map();
    }
  }

  return {
    sourceNetworkId: networkId,
    ...(sourceName !== undefined ? { sourceNetworkName: sourceName } : {}),
    getThought: (id) => etn.thoughts.get(networkId, id).catch(() => null),
    getPermanentComment: async (thoughtId) => {
      const list = await etn.comments.list(networkId, 'thought', thoughtId).catch(() => []);
      const perm = list.find((c) => c.kind === 'permanent');
      if (perm === undefined) return null;
      return { title: perm.title, body_md: perm.body_md };
    },
    getProperties: async (thoughtId) => {
      const thought = await etn.thoughts.get(networkId, thoughtId).catch(() => null);
      if (thought === null) return {};
      const [values, keys] = await Promise.all([
        etn.properties.get(networkId, 'thought', thoughtId).catch(() => []),
        resolvePropertyKeys(thought),
      ]);
      const out: Record<string, unknown> = {};
      for (const v of values) {
        const key = keys.get(v.property_id);
        if (key === undefined) continue;
        out[key] = v.value;
      }
      return out;
    },
    getAttachments: async (thoughtId) => {
      const list = await etn.attachments.list(networkId, 'thought', thoughtId).catch(() => []);
      return list.map((a) => ({
        kind: a.kind,
        url: a.url,
        file_path: a.file_path,
        file_size: a.file_size,
        mime_type: a.mime_type,
        title: a.title,
        description: a.description,
      }));
    },
    getLinksForThought: async (thoughtId) => {
      const grouped = await etn.links.listByThought(networkId, thoughtId, true).catch(() => null);
      if (grouped === null) return [];
      const all = [
        ...grouped.by_type.flatMap((g) => g.items.map((i) => i.link)),
        ...grouped.untyped_parents.map((u) => u.link),
        ...grouped.untyped_children.map((u) => u.link),
      ];
      return all.map((l) => ({
        id: l.id,
        source_id: l.source_id,
        target_id: l.target_id,
        type_id: l.type_id,
        color: l.color,
        style: l.style,
        width: l.width,
        active: l.active,
      }));
    },
    getThoughtTypeName: (typeId) => typeNames.get(typeId ?? null) ?? null,
    getLinkTypeNames: (typeId) => linkTypeNames.get(typeId ?? null) ?? null,
  };
}

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

/**
 * Delete command (08-ui-spec.md §5.3, §5a): a single selected thought opens the
 * one-off delete dialog (§5a.1); two or more open the group-delete dialog
 * (§5a.2), which handles the trash/purge split itself. Neither path clears or
 * closes the selection panel (§5a.2): physically deleted thoughts are pruned
 * one by one by `onThoughtDeleted`, marked ones stay in the list with their
 * trash marks refreshed.
 */
async function batchDelete(): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  if (ids.length === 1) {
    const id = ids[0]!;
    const title = getRef(id)?.title ?? id;
    await openThoughtDeleteDialog(networkId, { id, title });
    return;
  }
  await openThoughtGroupDeleteDialog(networkId, ids);
}

/** Starts an export job and saves the result through main process. */
async function runExport(format: ExportFormat, etnxOptions?: ExportEtnxOptions): Promise<void> {
  const networkId = requireNetworkId();
  const ids = store.state.selection;
  if (ids.length === 0) return;
  let options = etnxOptions;
  let targetPath: string | undefined;
  if (format === 'etnx' && options === undefined) {
    const dialog = await showExportEtnxDialog(ids.length);
    if (dialog.options === undefined) return; // cancelled
    if (dialog.targetPath === undefined) return; // no path picked
    options = dialog.options;
    targetPath = dialog.targetPath;
  }
  try {
    const payload: ExportRequest = {
      thought_ids: ids,
      format,
      ...(options === undefined ? {} : { etnx: options }),
    };
    const { job_id } = await etn.system.export(networkId, payload);
    notice(`Экспорт запущен (${job_id})…`);
    const job = await pollJob(job_id);
    if (job.status !== 'done') {
      notice('Экспорт завершился с ошибкой.', 'error');
      return;
    }
    const suggested =
      format === 'etnx' ? `etnx-${job_id}` : `etnx-${job_id}.${format}`;
    const result = await etn.system.downloadExport(
      job_id,
      suggested,
      targetPath,
    );
    if (result.error !== undefined) {
      notice(`Не удалось сохранить файл: ${result.error}`, 'error');
      return;
    }
    notice(`Экспорт сохранён: ${result.saved_path}`);
  } catch (err) {
    notice(`Экспорт не удался: ${errText(err)}`, 'error');
  }
}

/** Polls the job status until done/failed (max ~60 s). */
async function pollJob(jobId: string): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const job = await etn.system.getJob(jobId);
    if (job.status === 'done' || job.status === 'failed') return { status: job.status };
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
  }
  return { status: 'failed' };
}

/**
 * Apply a `.etnx` archive under the currently focused thought. Flow:
 *   1. OS file picker → filePath
 *   2. Slice-toggles dialog (types / attachments / chronology)
 *   3. Main process reads + base64 + POST /import/commit; the route fires
 *      realtime events so the canvas/panels refresh.
 */
async function runImport(): Promise<void> {
  const networkId = requireNetworkId();
  // Attach to the focused thought — this matches the spec (P7) and gives the
  // user a natural "import into here" intent.
  const focus = store.state.focus;
  const parentId = focus?.focused.id;
  if (parentId === undefined) {
    notice('Сначала сфокусируйте мысль — она станет родителем импортированного графа.', 'error');
    return;
  }
  let picked: Awaited<ReturnType<typeof etn.system.pickArchiveFile>>;
  try {
    picked = await etn.system.pickArchiveFile();
  } catch (err) {
    notice(`Импорт не удался: ${errText(err)}`, 'error');
    return;
  }
  if (picked.cancelled) return;
  if (picked.error !== undefined || picked.filePath === null) {
    notice(`Импорт не удался: ${picked.error ?? 'файл не выбран'}`, 'error');
    return;
  }
  const dialog = await showImportEtnxDialog(picked.filePath);
  if (dialog.filePath === undefined || dialog.options === undefined) return;
  try {
    const result = await etn.system.importEtnx(
      networkId,
      parentId,
      dialog.filePath,
      dialog.options,
    );
    if (result.cancelled) return;
    if (result.error !== undefined) {
      notice(`Импорт не удался: ${result.error}`, 'error');
      return;
    }
    const s = result.summary;
    notice(
      `Импорт ${result.filename}: создано ${s.thoughts_created}, обновлено ${s.thoughts_updated}, ` +
        `новых связей ${s.links_created}, вложений ${s.attachments_imported}.`,
    );
  } catch (err) {
    notice(`Импорт не удался: ${errText(err)}`, 'error');
  }
}
