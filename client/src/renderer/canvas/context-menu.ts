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
import {
  buildSingleThoughtSnapshot,
  getClipboard,
  hasClipboard,
  pasteThoughtsTo as pasteThoughtsToClipboard,
  type SnapshotDeps,
} from './clipboard.js';
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
import { showImportEtnxDialog } from '../import-export/import-dialog.js';

/** Run an `.etnx` export for a single thought (phase P, task P7). The polling
 *  loop and save flow mirror `selection.ts:runExport`; we keep a local copy
 *  to avoid coupling the context-menu to the selection panel. */
async function exportSingleThought(networkId: string, thoughtId: string): Promise<void> {
  const dialog = await showExportEtnxDialog(1);
  if (dialog.options === undefined) return;
  if (dialog.targetPath === undefined) return;
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
    const result = await etn.system.downloadExport(job_id, '', dialog.targetPath);
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
 * `parentThoughtId` (phase P, task P7). Flow:
 *   1. OS file picker → filePath
 *   2. Slice-toggles dialog (types / attachments / chronology)
 *   3. Main process reads the file, base64-encodes, POSTs /import/commit;
 *      the route fires realtime events so the canvas/panels refresh.
 */
async function importToThought(networkId: string, parentThoughtId: string): Promise<void> {
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
      parentThoughtId,
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
  const focusHasParent = focus !== null && focus.parents.length > 0;
  const siblingParentId = focus?.parents[0]?.id;
  const inSelection = store.state.selection.includes(target.id);
  // Manual order is only available in the parents/children zones while the
  // active sort is «ручной» (08-ui-spec.md §2.7, docs/03-server-api.md §6.2).
  // Compute the thought's index in the zone up-front so each submenu row can
  // gate itself on its own position-based condition (not first / not last).
  const zoneSort =
    focus !== null ? focus.sorts[target.dir].sort : 'alpha';
  const canReorder =
    focus !== null &&
    (target.dir === 'parents' || target.dir === 'children') &&
    zoneSort === 'manual';
  let zoneIdx = -1;
  let zoneLen = 0;
  if (canReorder && (target.dir === 'parents' || target.dir === 'children')) {
    const order = store.state.zoneOrder[target.dir];
    zoneLen = order.length;
    zoneIdx = order.indexOf(target.id);
  }
  const isZoneFirst = canReorder && zoneIdx === 0;
  const isZoneLast = canReorder && zoneIdx === zoneLen - 1;

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
      // Submenu is enabled only while the zone is sorted «ручной» (08-ui-spec.md
      // §2.7). Siblings never accept manual order (§6.2); for parents/children
      // each row self-gates on its own position condition so the user gets a
      // precise signal of what is and is not possible right now.
      label: 'Изменить порядок',
      disabled: !canReorder,
      submenu: [
        {
          label: 'сделать первой',
          disabled: !canReorder || isZoneFirst,
          onClick: () =>
            void moveInZone(networkId, target.id, target.dir as OrderableDir, 0),
        },
        {
          label: 'сдвинуть назад',
          disabled: !canReorder || isZoneFirst,
          onClick: () =>
            void moveInZone(
              networkId,
              target.id,
              target.dir as OrderableDir,
              zoneIdx - 1,
            ),
        },
        {
          label: 'сдвинуть вперёд',
          disabled: !canReorder || isZoneLast,
          onClick: () =>
            void moveInZone(
              networkId,
              target.id,
              target.dir as OrderableDir,
              zoneIdx + 1,
            ),
        },
        {
          label: 'сделать последней',
          disabled: !canReorder || isZoneLast,
          onClick: () =>
            void moveInZone(
              networkId,
              target.id,
              target.dir as OrderableDir,
              zoneLen - 1,
            ),
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
      onClick: () => void copyThought(target, networkId),
    },
    {
      label: 'Вставить',
      disabled: !hasClipboard(),
      onClick: () => void pasteThoughtsTo(networkId, target.id),
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

/**
 * Captures the thought the user clicked "Copy" on into the in-memory
 * clipboard (workplan L26). The full snapshot — title, synonyms, style,
 * type tag, permanent comment, property values, attachments — is fetched
 * lazily, so a click feels instant even on a thought with many attachments.
 */
async function copyThought(
  target: { id: string; title: string },
  networkId: string,
): Promise<void> {
  try {
    const thought = await etn.thoughts.get(networkId, target.id);
    const deps = makeSnapshotDeps(networkId);
    await buildSingleThoughtSnapshot(thought, deps);
    notice(`Скопировано: «${thought.title}»`);
  } catch (err) {
    errorDialog('Копировать', err);
  }
}

/** Thin context-menu wrapper around the clipboard paste helper. */
async function pasteThoughtsTo(networkId: string, targetId: string): Promise<void> {
  void networkId; // the helper pulls the current network from store state.
  await pasteThoughtsToClipboard(targetId);
  scheduleRefresh();
}

/** Build a SnapshotDeps bound to the current renderer / network. */
function makeSnapshotDeps(networkId: string): SnapshotDeps {
  const typeNames = new Map<string | null, string | null>();
  for (const t of store.state.thoughtTypes) {
    typeNames.set(t.id, t.name);
  }
  const linkTypeNames = new Map<string | null, { name_forward: string | null; name_reverse: string | null }>();
  for (const t of store.state.linkTypes) {
    linkTypeNames.set(t.id, { name_forward: t.name_forward, name_reverse: t.name_reverse });
  }
  const sourceName = store.state.networkList.find((n) => n.id === networkId)?.display_name;

  // Cache for `property_id → key` lookups. The PropertyValue DTO carries
  // only the id, so we resolve the key through the type's effective
  // property list. Each thought type is looked up at most once.
  const propertyKeyCache = new Map<string, string>();
  async function resolvePropertyKeys(thought: { type_id: string | null }): Promise<Map<string, string>> {
    if (thought.type_id === null) return new Map();
    const cached = propertyKeyCache.get(thought.type_id);
    if (cached !== undefined) return new Map(Object.entries(JSON.parse(cached) as Record<string, string>));
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
    getThought: (id) =>
      etn.thoughts.get(networkId, id).catch(() => null),
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

/**
 * Moves a thought to the given slot in its zone's manual order
 * (08-ui-spec.md §2.6, §2.7). Called by the «Изменить порядок» submenu rows
 * for the four actions — make-first, shift-back, shift-forward, make-last —
 * each of which passes the appropriate absolute `toIndex`. The caller is
 * responsible for gating on `sort=manual` and on the position condition; this
 * function bails out only when the move is a no-op or the focus is gone.
 */
async function moveInZone(
  networkId: string,
  id: string,
  dir: OrderableDir,
  toIndex: number,
): Promise<void> {
  const focus = store.state.focus;
  if (focus === null) return;
  const list = dir === 'parents' ? focus.parents : focus.children;
  const ids = [...new Set(list.map((n) => n.id))];
  const index = ids.indexOf(id);
  if (index < 0) return;
  const clamped = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (clamped === index) return;
  ids.splice(index, 1);
  ids.splice(clamped, 0, id);
  try {
    await etn.thoughts.setFocusOrder(networkId, focus.focused.id, { dir, ordered_ids: ids });
    await etn.thoughts.setFocusPreferences(networkId, focus.focused.id, {
      dir,
      sort: 'manual',
      order: 'asc',
    });
    // Mirror drag-cloud.ts: arm the FLIP animation so the refreshed zone
    // shifts its clouds to their new positions instead of snapping.
    requestZoneAnimation();
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
  // The currently applied sort for this zone. The focus response carries the
  // full `{ sort, order }` (08-ui-spec.md §2.7, docs/03-server-api.md §6.7/§6.8)
  // so we can mark the matching row of the submenu — otherwise the user has
  // no signal of which mode is currently active.
  const current = focus.sorts[dir];

  const sortItem = (
    label: string,
    sort: 'alpha' | 'created' | 'viewed',
    order: 'asc' | 'desc',
  ): MenuItem => ({
    label,
    checked: current.sort === sort && current.order === order,
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
          checked: current.sort === 'manual',
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
