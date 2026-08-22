/**
 * Context menus and zone sorting (H15, 08-ui-spec.md §2.6, §2.7).
 *
 * - thought context menu (right-click on a cloud): add parent/child/sibling,
 *   toggle activity, reorder (manual zones), change type, change icon, add
 *   attachment (focus + editor), open editor, find on the map (structures
 *   view, L23), add to selection (H16), copy/cut/paste (link creation),
 *   delete;
 * - zone context menu: sort by alpha/created/viewed × asc/desc and manual
 *   (parents/children only) → `thoughts.setFocusPreferences`;
 * - drag-reorder: dragging a cloud to another position switches the zone to
 *   manual order via `thoughts.setFocusOrder`.
 *
 * Registration happens through canvas hooks (`setCloudContextMenuHandler`,
 * `setZoneContextMenuHandler`, `setCloudDragHandlers`).
 */

import type { FocusDir, Link } from '@etn/shared';

import { onThoughtDeleted, scheduleRefresh, requireNetworkId, setFocus } from '../app.js';
import { openAddDialog } from './add-dialog.js';
import { invalidateRef, requestZoneAnimation } from './canvas.js';
import { patchFocusEdge, store } from '../state.js';
import { confirmDialog, errorDialog, promptDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { orderedTypeRows } from '../lib/type-tree.js';
import { isPinned, togglePinned } from '../pinned/pins.js';
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import { errText } from '../lib/dom.js';
import { showExportEtnxDialog } from '../import-export/export-dialog.js';

/** Run an `.etnx` export for a single thought (phase P, task P7). The polling
 *  loop and save flow mirror `selection.ts:runExport`; we keep a local copy
 *  to avoid coupling the context-menu to the selection panel. */
async function exportSingleThought(networkId: string, thoughtId: string): Promise<void> {
  const dialog = await showExportEtnxDialog(1);
  if (dialog.options === undefined) return;
  try {
    const { job_id } = await etn.system.export(networkId, {
      thought_ids: [thoughtId],
      format: 'etnx',
      etnx: dialog.options,
    });
    notice(`Экспорт запущен (${job_id})…`);
    const job = await pollJob(job_id);
    if (job.status !== 'done') {
      notice('Экспорт завершился с ошибкой.', 'error');
      return;
    }
    const suggested = dialog.filename ?? `etnx-${job_id}`;
    const result = await etn.system.downloadExport(job_id, suggested);
    if (result.cancelled) {
      notice('Сохранение отменено.');
      return;
    }
    if (result.error !== undefined) {
      notice(`Не удалось сохранить файл: ${result.error}`, 'error');
      return;
    }
    notice(`Экспорт сохранён: ${result.saved_path}`);
  } catch (err) {
    notice(`Экспорт не удался: ${errText(err)}`, 'error');
  }
}

/**
 * Import a `.etnx` archive and attach its root thoughts as children of
 * `parentThoughtId` (phase P, task P7). The main process handles the file
 * picker + base64 + REST roundtrip; we just show the result as a notice.
 */
async function importToThought(networkId: string, parentThoughtId: string): Promise<void> {
  try {
    const result = await etn.system.importEtnx(networkId, parentThoughtId);
    if (result.cancelled) {
      // user closed the file picker — no message needed
      return;
    }
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

async function pollJob(jobId: string): Promise<{ status: string }> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const job = await etn.system.getJob(jobId);
    if (job.status === 'done' || job.status === 'failed') return { status: job.status };
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
  }
  return { status: 'failed' };
}

/** Zone direction (parents/siblings/children). */
type ZoneDir = 'parents' | 'siblings' | 'children';

/** Entry shown in a cloud menu. */
interface CloudMenuTarget {
  id: string;
  title: string;
  dir: ZoneDir;
}

/** The thought/type clipboard (copy/cut/paste). */
let clipboard: { id: string; cut: boolean } | null = null;

/** Thought ids that may be reordered (parents/children only). */
type OrderableDir = 'parents' | 'children';

/** Hook signature: the selection module (H16) registers an adder here. */
let addToSelectionHook: ((id: string) => void) | null = null;

/** Registers the "add to selection" hook (H16). */
export function setAddToSelectionHook(next: ((id: string) => void) | null): void {
  addToSelectionHook = next;
}

/** Hook signature: the editor registers the link-settings dialog opener here. */
let linkSettingsHook: ((link: Link) => void) | null = null;

/** Registers the link settings dialog opener (editor mount does this). */
export function setLinkSettingsOpener(next: ((link: Link) => void) | null): void {
  linkSettingsHook = next;
}

/** Opens the link context menu at the event position (08-ui-spec.md §2.6). */
export function showLinkContextMenu(event: MouseEvent, linkId: string): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  showMenuAt(event.clientX, event.clientY, buildLinkMenuItems(networkId, linkId));
}

/** Builds the link menu items: properties / activity / invert / delete. */
function buildLinkMenuItems(networkId: string, linkId: string): MenuItem[] {
  return [
    {
      label: 'Изменить свойства',
      onClick: () => void openLinkSettings(networkId, linkId),
    },
    {
      label: 'Изменить актуальность',
      onClick: () => void toggleLinkActive(networkId, linkId),
    },
    {
      label: 'Инвертировать',
      onClick: () => void invertLink(networkId, linkId),
    },
    MENU_SEPARATOR,
    {
      label: 'Удалить',
      danger: true,
      onClick: () => void deleteLink(networkId, linkId),
    },
  ];
}

/** Opens the link settings dialog (colour/style/width + reset). */
async function openLinkSettings(networkId: string, linkId: string): Promise<void> {
  try {
    const link = await etn.links.get(networkId, linkId);
    linkSettingsHook?.(link);
  } catch (err) {
    errorDialog('Изменить свойства', err);
  }
}

/** Toggles the link's active flag; inactive links hide with "hide inactive". */
async function toggleLinkActive(networkId: string, linkId: string): Promise<void> {
  try {
    const link = await etn.links.get(networkId, linkId);
    const updated = await etn.links.update(
      networkId,
      linkId,
      { active: !link.active },
      link.version,
    );
    // Repaint at once (no realtime echo to the actor, 04-realtime.md §5);
    // the debounced refresh reconciles the neighbour zones.
    patchFocusEdge(updated);
    scheduleRefresh();
  } catch (err) {
    errorDialog('Изменить актуальность', err);
  }
}

/**
 * Swaps the link's direction: source ⇄ target (08-ui-spec.md §2.4). The line
 * re-anchors at once; the animated refresh then reconciles the zones — the
 * former source may leave «Родители» for «Низ» and vice versa.
 */
async function invertLink(networkId: string, linkId: string): Promise<void> {
  try {
    const link = await etn.links.get(networkId, linkId);
    const updated = await etn.links.update(
      networkId,
      linkId,
      { source_id: link.target_id, target_id: link.source_id },
      link.version,
    );
    // No realtime echo to the actor (04-realtime.md §5) — patch locally. Both
    // store updates render synchronously BEFORE the animation flag is armed,
    // so the flag is consumed by the debounced zone-reconciling refresh only.
    patchFocusEdge(updated);
    const target = store.state.editorTarget;
    if (target !== null && target.kind === 'link' && target.id === linkId) {
      store.update({ editorTarget: { kind: 'link', id: updated.id, link: updated } });
    }
    requestZoneAnimation();
    scheduleRefresh();
    notice('Связь инвертирована.');
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'DUPLICATE') {
      notice('В обратном направлении такая связь уже существует.', 'error');
      return;
    }
    errorDialog('Инвертировать связь', err);
  }
}

/**
 * Deletes a link after a confirmation. Shared by the canvas link menu and the
 * editor's links group. Resolves `true` when the link was actually deleted.
 */
export async function deleteLink(networkId: string, linkId: string): Promise<boolean> {
  if (!(await confirmDialog('Удалить связь', 'Удалить связь?', true))) return false;
  try {
    const link = await etn.links.get(networkId, linkId);
    await etn.links.remove(networkId, linkId, link.version);
    // Drop the line at once; the debounced refresh reconciles the zones.
    patchFocusEdge({ ...link, active: false });
    // If the deleted link was open in the editor, drop the editor target.
    const target = store.state.editorTarget;
    if (target !== null && target.kind === 'link' && target.id === linkId) {
      store.update({ editorTarget: null, selectedLinkId: null });
    }
    scheduleRefresh();
    return true;
  } catch (err) {
    errorDialog('Удалить связь', err);
    return false;
  }
}

/** Opens the thought context menu at the event position. */
export function showThoughtContextMenu(
  event: MouseEvent,
  target: CloudMenuTarget,
  opts: {
    openHandler?: (id: string) => void;
    findOnMapHandler?: (id: string) => void;
  } = {},
): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  showMenuAt(
    event.clientX,
    event.clientY,
    buildThoughtMenuItems(networkId, target, {
      openHandler: opts.openHandler,
      findOnMapHandler: opts.findOnMapHandler,
    }),
  );
}

/**
 * Opens the thought context menu for a selection-list entry (08-ui-spec.md
 * §5.1): the same commands as on the canvas, except the add/remove-selection
 * toggle — the entry is already selected.
 */
export function showSelectionThoughtContextMenu(event: MouseEvent, target: CloudMenuTarget): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  showMenuAt(
    event.clientX,
    event.clientY,
    buildThoughtMenuItems(networkId, target, { hideSelectionCommand: true }),
  );
}

/** Builds the thought menu items (08-ui-spec.md §2.6). */
function buildThoughtMenuItems(
  networkId: string,
  target: CloudMenuTarget,
  opts: {
    hideSelectionCommand?: boolean;
    openHandler?: (id: string) => void;
    findOnMapHandler?: (id: string) => void;
  } = {},
): MenuItem[] {
  const focus = store.state.focus;
  const isFocus = focus?.focused.id === target.id;
  const focusHasParent = focus !== null && focus.parents.length > 0;
  const siblingParentId = focus?.parents[0]?.id;
  const inSelection = store.state.selection.includes(target.id);

  const selectionItem: MenuItem[] =
    opts.hideSelectionCommand === true
      ? []
      : [
          {
            label: inSelection ? 'Убрать из выделенных' : 'Добавить к выделению',
            onClick: () => addToSelectionHook?.(target.id),
          },
        ];

  return [
    {
      label: 'Добавить',
      submenu: [
        {
          label: 'вверх (родитель)',
          onClick: () => openAddDialog({ anchorId: target.id, direction: 'parent' }),
        },
        {
          label: 'вниз (ребёнок)',
          onClick: () => openAddDialog({ anchorId: target.id, direction: 'child' }),
        },
        {
          label: 'налево (родственник)',
          disabled: !focusHasParent || siblingParentId === undefined,
          onClick: () => {
            if (siblingParentId !== undefined) {
              openAddDialog({ anchorId: siblingParentId, direction: 'child' });
            }
          },
        },
      ],
    },
    {
      label: 'Изменить актуальность',
      onClick: () => void toggleActive(networkId, target.id),
    },
    {
      label: 'Изменить порядок',
      disabled: target.dir === 'siblings' || !isFocus,
      submenu: [
        {
          label: 'сдвинуть вверх / первым',
          onClick: () => void moveInZone(networkId, target.id, target.dir as OrderableDir, -1),
        },
        {
          label: 'сдвинуть вниз / последним',
          onClick: () => void moveInZone(networkId, target.id, target.dir as OrderableDir, 1),
        },
      ],
    },
    {
      label: 'Изменить тип',
      submenu: buildTypeMenu(networkId, target.id),
    },
    {
      label: 'Изменить иконку',
      onClick: () => void changeIcon(networkId, target.id),
    },
    {
      // In the structures view (L15) both commands open the editor without
      // switching the canvas focus; on the canvas they focus the thought.
      label: 'Добавить вложение',
      onClick: () => {
        if (opts.openHandler !== undefined) opts.openHandler(target.id);
        else void setFocus(target.id);
      },
    },
    MENU_SEPARATOR,
    {
      label: 'Открыть редактор',
      onClick: () => {
        if (opts.openHandler !== undefined) opts.openHandler(target.id);
        else void setFocus(target.id);
      },
    },
    {
      label: 'Экспорт…',
      onClick: () => void exportSingleThought(networkId, target.id),
    },
    {
      label: 'Импорт…',
      onClick: () => void importToThought(networkId, target.id),
    },
    ...(opts.findOnMapHandler !== undefined
      ? [
          {
            // Structures-only command (L23, 08-ui-spec.md §15.8): jump to the
            // map view with this thought focused.
            label: 'Найти на карте мыслей',
            onClick: () => opts.findOnMapHandler?.(target.id),
          },
        ]
      : []),
    {
      // Pinned-thoughts command (L18, 08-ui-spec.md §16): available in every
      // thought menu — the canvas, the selection panel, the structures tree,
      // the history chips and the pinned panel itself.
      label: isPinned(target.id) ? 'Открепить мысль' : 'Закрепить мысль',
      onClick: () => void togglePinned(target.id),
    },
    ...selectionItem,
    {
      label: 'Копировать',
      onClick: () => {
        clipboard = { id: target.id, cut: false };
        notice(`Скопировано: «${target.title}»`);
      },
    },
    {
      label: 'Вырезать',
      onClick: () => {
        clipboard = { id: target.id, cut: true };
        notice(`Вырезано: «${target.title}»`);
      },
    },
    {
      label: 'Вставить',
      disabled: clipboard === null,
      onClick: () => void pasteTo(networkId, target.id),
    },
    {
      label: 'Копировать ID',
      onClick: () => {
        void navigator.clipboard.writeText(target.id).then(
          () => notice('ID мысли скопирован.'),
          () => notice('Не удалось скопировать ID.', 'error'),
        );
      },
    },
    MENU_SEPARATOR,
    {
      label: 'Удалить',
      danger: true,
      onClick: () => void deleteThought(networkId, target),
    },
  ];
}

/** Internals exported for unit tests. */
export const menuInternals = { buildThoughtMenuItems };

/** Type-change submenu (type tree with indents + clear; L21). */
function buildTypeMenu(networkId: string, thoughtId: string): MenuItem[] {
  // The hierarchy root is not assignable to thoughts (L21) — skip it.
  const items: MenuItem[] = orderedTypeRows(store.state.thoughtTypes)
    .filter((row) => !row.type.is_root)
    .map((row) => ({
      label: `${'· '.repeat(Math.max(0, row.depth - 2))}${row.type.name}`,
      onClick: () => void changeType(networkId, thoughtId, row.type.id),
    }));
  items.push({ label: 'очистить тип', onClick: () => void changeType(networkId, thoughtId, null) });
  return items;
}

/** Toggles the active flag. */
async function toggleActive(networkId: string, id: string): Promise<void> {
  try {
    const thought = await etn.thoughts.get(networkId, id);
    if (thought.is_protected && thought.is_root) {
      notice('HOME-мысль нельзя деактивировать.', 'error');
      return;
    }
    await etn.thoughts.update(networkId, id, { active: !thought.active }, thought.version);
    // No realtime echo to the actor (04-realtime.md §5) — drop the cached ref
    // so the refreshed zones re-resolve the thought and repaint the dim state.
    invalidateRef(id);
    scheduleRefresh();
  } catch (err) {
    errorDialog('Изменить актуальность', err);
  }
}

/** Changes the thought type. */
async function changeType(networkId: string, id: string, typeId: string | null): Promise<void> {
  try {
    const thought = await etn.thoughts.get(networkId, id);
    await etn.thoughts.update(networkId, id, { type_id: typeId }, thought.version);
    // The type drives the cloud icon/colours — drop the stale cached ref so
    // the next refresh resolves the new style instead of the old one.
    invalidateRef(id);
    scheduleRefresh();
    // Шаблон комментария типа (08-ui-spec.md §8.1): применяется к пустому
    // постоянному комментарию сразу после назначения/смены типа.
    await applyCommentTemplateIfEmpty(networkId, id, typeId);
  } catch (err) {
    errorDialog('Изменить тип', err);
  }
}

/** Prompts for a new emoji icon. */
async function changeIcon(networkId: string, id: string): Promise<void> {
  const current = await etn.thoughts.get(networkId, id).catch(() => null);
  const value = await promptDialog('Изменить иконку', 'Эмодзи', current?.icon ?? '');
  if (value === null) return;
  try {
    const thought = await etn.thoughts.get(networkId, id);
    await etn.thoughts.update(
      networkId,
      id,
      { icon: value.trim() === '' ? null : value.trim(), icon_kind: 'emoji' },
      thought.version,
    );
    invalidateRef(id);
    scheduleRefresh();
  } catch (err) {
    errorDialog('Изменить иконку', err);
  }
}

/** Pastes the clipboard as a source linked to the target thought. */
async function pasteTo(networkId: string, targetId: string): Promise<void> {
  if (clipboard === null) return;
  try {
    await etn.links.create(networkId, {
      source_id: clipboard.id,
      target_id: targetId,
    });
    if (clipboard.cut) clipboard = null;
    notice('Связь создана.');
    scheduleRefresh();
  } catch (err) {
    errorDialog('Вставить', err);
  }
}

/**
 * Deletes a thought after confirmation. Shared by the canvas thought menu and
 * the editor's links group. Resolves `true` when it was actually deleted.
 */
export async function deleteThought(
  networkId: string,
  target: { id: string; title: string },
): Promise<boolean> {
  if (!(await confirmDialog('Удалить мысль', `Удалить «${target.title}»?`, true))) return false;
  try {
    const thought = await etn.thoughts.get(networkId, target.id);
    await etn.thoughts.remove(networkId, target.id, thought.version);
    // No realtime echo to the actor (04-realtime.md §5) — clean up locally:
    // history, caches, and (for the focused thought) the next focus (L4).
    await onThoughtDeleted(target.id);
    return true;
  } catch (err) {
    errorDialog('Удалить мысль', err);
    return false;
  }
}

/** Moves a thought one step in its zone (manual order). */
async function moveInZone(
  networkId: string,
  id: string,
  dir: OrderableDir,
  delta: number,
): Promise<void> {
  const focus = store.state.focus;
  if (focus === null) return;
  const list = dir === 'parents' ? focus.parents : focus.children;
  const ids = [...new Set(list.map((n) => n.id))];
  const index = ids.indexOf(id);
  if (index < 0) return;
  const targetIndex = Math.max(0, Math.min(ids.length - 1, index + delta));
  if (targetIndex === index) return;
  ids.splice(index, 1);
  ids.splice(targetIndex, 0, id);
  try {
    await etn.thoughts.setFocusOrder(networkId, focus.focused.id, { dir, ordered_ids: ids });
    await etn.thoughts.setFocusPreferences(networkId, focus.focused.id, {
      dir,
      sort: 'manual',
      order: 'asc',
    });
    scheduleRefresh();
  } catch (err) {
    errorDialog('Изменить порядок', err);
  }
}

// ---------------------------------------------------------------------------
// Zone sort menu
// ---------------------------------------------------------------------------

/** Opens the zone context menu (add thought — L19; sorting, 08-ui-spec.md §2.7). */
export function showZoneContextMenu(event: MouseEvent, dir: ZoneDir): void {
  const networkId = store.state.networkId;
  const focus = store.state.focus;
  if (networkId === null || focus === null) return;
  const manual = dir !== 'siblings';

  const sortItem = (
    label: string,
    sort: 'alpha' | 'created' | 'viewed',
    order: 'asc' | 'desc',
  ): MenuItem => ({
    label,
    onClick: () => void setZoneSort(networkId, focus.focused.id, dir, sort, order),
  });

  // «Добавить мысль» (L19) lives only in the parents/children zones: the zone
  // itself tells the direction; the siblings zone has no unambiguous anchor.
  const addItem: MenuItem[] =
    dir === 'siblings'
      ? []
      : [
          {
            label: 'Добавить мысль',
            onClick: () =>
              openAddDialog({
                anchorId: focus.focused.id,
                direction: dir === 'parents' ? 'parent' : 'child',
              }),
          },
        ];

  showMenuAt(event.clientX, event.clientY, [
    ...addItem,
    {
      label: 'Сортировка',
      submenu: [
        sortItem('по алфавиту (возр)', 'alpha', 'asc'),
        sortItem('по алфавиту (убыв)', 'alpha', 'desc'),
        sortItem('по дате создания (возр)', 'created', 'asc'),
        sortItem('по дате создания (убыв)', 'created', 'desc'),
        sortItem('по дате просмотра (возр)', 'viewed', 'asc'),
        sortItem('по дате просмотра (убыв)', 'viewed', 'desc'),
        {
          label: 'ручной',
          disabled: !manual,
          onClick: () => {
            if (manual) void setZoneSort(networkId, focus.focused.id, dir, 'manual', 'asc');
          },
        },
      ],
    },
  ]);
}

/** Applies a zone sort preference and refreshes the zone. */
async function setZoneSort(
  networkId: string,
  focusId: string,
  dir: ZoneDir,
  sort: 'manual' | 'alpha' | 'created' | 'viewed',
  order: 'asc' | 'desc',
): Promise<void> {
  // Manual ordering is always ascending — there is no semantic meaning to a
  // reversed manual list (08-ui-spec.md §2.7). Normalise here so accidental
  // callers (or future UI) cannot leak `desc` through to the server, which
  // would reject it with VALIDATION_ERROR.
  const effectiveOrder: 'asc' | 'desc' = sort === 'manual' ? 'asc' : order;
  try {
    // First-time switch to manual: initialise user_focus_order with the
    // currently visible order. Without this, every neighbour has
    // manual_position === null (no row in user_focus_order yet), the visual
    // indicator (.cloud-pos, 08-ui-spec.md §2.2) is hidden for all of them,
    // and the user sees no numbering at all — looking as if the feature is
    // broken. By committing the current zoneOrder up-front we get positions
    // 0..N-1 (via setFocusOrder's replace semantics, 02-data-model.md §3.10.4)
    // and the indicators appear immediately after refresh.
    if (sort === 'manual' && (dir === 'parents' || dir === 'children')) {
      const currentOrder = store.state.zoneOrder[dir];
      if (currentOrder.length > 0) {
        await etn.thoughts.setFocusOrder(networkId, focusId, {
          dir,
          ordered_ids: currentOrder,
        });
      }
    }
    await etn.thoughts.setFocusPreferences(networkId, focusId, {
      dir: dir as FocusDir,
      sort,
      order: effectiveOrder,
    });
    scheduleRefresh();
  } catch (err) {
    errorDialog('Сортировка', err);
  }
}

// ---------------------------------------------------------------------------
// Drag-reorder (manual order)
// ---------------------------------------------------------------------------

/** Wires HTML5 drag-reorder on orderable zones (parents/children). */
export function wireCloudReorder(
  zone: HTMLElement,
  dir: OrderableDir,
  cloudEls: () => HTMLElement[],
): void {
  zone.addEventListener('dragstart', (event) => {
    const cloud = (event.target as HTMLElement).closest<HTMLElement>('.cloud');
    if (cloud === null) return;
    const id = cloud.dataset['id'];
    if (id === undefined) return;
    const transfer = event.dataTransfer;
    if (transfer !== null) {
      transfer.setData('text/plain', `${dir}:${id}`);
      transfer.effectAllowed = 'move';
    }
  });

  zone.addEventListener('dragover', (event) => {
    const transfer = event.dataTransfer;
    if (transfer !== null) {
      if (!transfer.types.includes('text/plain')) return;
      event.preventDefault();
      transfer.dropEffect = 'move';
    }
  });

  zone.addEventListener('drop', (event) => {
    const payload = event.dataTransfer?.getData('text/plain') ?? '';
    const [dirFrom, id] = payload.split(':') as [string | undefined, string | undefined];
    if (dirFrom === undefined || id === undefined || dirFrom !== dir) return;
    event.preventDefault();
    const ids = cloudEls()
      .map((cloud) => cloud.dataset['id'])
      .filter((cloudId): cloudId is string => cloudId !== undefined);
    // Dropped at the end (empty zone area) keeps the current position.
    const over = (event.target as HTMLElement).closest<HTMLElement>('.cloud');
    if (over === null) return;
    const overId = over.dataset['id'];
    if (overId === undefined) return;
    const from = ids.indexOf(id);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void commitOrder(dir, ids);
  });
}

/** Commits a manual order for a zone. */
async function commitOrder(dir: OrderableDir, ids: string[]): Promise<void> {
  const networkId = requireNetworkId();
  const focus = store.state.focus;
  if (focus === null) return;
  try {
    await etn.thoughts.setFocusOrder(networkId, focus.focused.id, { dir, ordered_ids: ids });
    await etn.thoughts.setFocusPreferences(networkId, focus.focused.id, {
      dir,
      sort: 'manual',
      order: 'asc',
    });
    scheduleRefresh();
  } catch (err) {
    errorDialog('Изменить порядок', err);
  }
}
