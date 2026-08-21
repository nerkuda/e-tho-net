/**
 * Bulk commands over the applied structures filter (L22, 08-ui-spec.md §15.3).
 *
 * The «Команды ▾» button next to «Применить»/«Очистить» opens this menu. Every
 * command applies to ALL thoughts of the last APPLIED filter — pagination of
 * the visible tree plays no role: ids are collected through the `ids_only`
 * query (03-server-api.md §6.10) page by page. Commands act on the applied
 * filter, not on the panel draft: what the results tree shows is what the
 * command touches.
 *
 * Selection commands are client-side (the shared selection panel, §5); the
 * rest run as one `thoughts.batch` call (03-server-api.md §6.6). Link
 * commands open the picker with thought creation allowed: the chosen thought
 * type applies to the new thoughts only, the chosen link type — to the links
 * the command creates; already linked pairs keep their type. Destructive
 * commands (only parents / unlink / delete) ask for a confirmation; the
 * unlink pickers never create thoughts.
 */

import {
  STRUCTURES_QUERY_IDS_MAX_LIMIT,
  type SortOrder,
  type StructureFilter,
  type StructureSort,
  type ThoughtBatchArgs,
  type ThoughtBatchOp,
} from '@etn/shared';

import { pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { errText } from '../../lib/dom.js';
import { confirmDialog, errorDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { pickThoughtType } from '../../selection/dialogs.js';
import { addToSelection, removeFromSelection } from '../../selection/selection.js';
import { store } from '../../state.js';

/** The applied filter the commands run against (owned by structures.ts). */
export interface FilterCommandsContext {
  filter: StructureFilter;
  sort: StructureSort;
  order: SortOrder;
  /** Runs after a server command so the results tree refetches its page. */
  refresh(): void;
}

/** Opens the command menu below the footer «Команды ▾» button. */
export function openFilterCommandsMenu(anchor: HTMLElement, ctx: FilterCommandsContext): void {
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom + 2, buildMenu(ctx));
}

/** The «Команды» menu itself (§15.3): selection, activity/type, links, delete. */
function buildMenu(ctx: FilterCommandsContext): MenuItem[] {
  return [
    { label: 'Добавить к выделенным', onClick: () => void cmdSelection(ctx, true) },
    { label: 'Удалить из выделенных', onClick: () => void cmdSelection(ctx, false) },
    MENU_SEPARATOR,
    { label: 'Сделать актуальными', onClick: () => void cmdBatch(ctx, 'set_active', {}) },
    { label: 'Сделать неактуальными', onClick: () => void cmdBatch(ctx, 'set_inactive', {}) },
    { label: 'Изменить тип мыслей…', onClick: () => void cmdChangeType(ctx) },
    MENU_SEPARATOR,
    { label: 'Добавить родительские мысли…', onClick: () => void cmdLinkAnchors(ctx, 'parents') },
    { label: 'Сделать единственными родителями…', onClick: () => void cmdOnlyParents(ctx) },
    { label: 'Разорвать связи с родителями…', onClick: () => void cmdUnlinkAnchors(ctx, 'parents') },
    { label: 'Добавить подчинённые мысли…', onClick: () => void cmdLinkAnchors(ctx, 'children') },
    { label: 'Разорвать связи с подчинёнными…', onClick: () => void cmdUnlinkAnchors(ctx, 'children') },
    MENU_SEPARATOR,
    { label: 'Удалить', danger: true, onClick: () => void cmdDelete(ctx) },
  ];
}

// ---------------------------------------------------------------------------
// Id collection
// ---------------------------------------------------------------------------

/** Safety cap of {@link collectAllIds} pages (2000 ids per page). */
const COLLECT_MAX_PAGES = 200;

/**
 * Collects the ids of EVERY thought matching the applied filter — the whole
 * result, not just the visible page. Pages walk the same ordering as the
 * tree query, so offsets line up.
 */
async function collectAllIds(ctx: FilterCommandsContext): Promise<string[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];
  const ids: string[] = [];
  for (let page = 0; page < COLLECT_MAX_PAGES; page++) {
    const result = await etn.structures.queryIds(networkId, {
      ...ctx.filter,
      sort: ctx.sort,
      order: ctx.order,
      limit: STRUCTURES_QUERY_IDS_MAX_LIMIT,
      offset: ids.length,
    });
    ids.push(...result.ids);
    if (ids.length >= result.total || result.ids.length === 0) return ids;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Selection commands: push/remove the whole filter result (client-side). */
async function cmdSelection(ctx: FilterCommandsContext, add: boolean): Promise<void> {
  let ids: string[];
  try {
    ids = await collectAllIds(ctx);
  } catch (err) {
    errorDialog('Команды отбора', err);
    return;
  }
  if (ids.length === 0) {
    notice('Отбор пуст — команда не применена.');
    return;
  }
  if (add) {
    addToSelection(ids);
    notice(`Добавлено к выделению: ${ids.length}.`);
    return;
  }
  const selected = new Set(store.state.selection);
  const overlap = ids.filter((id) => selected.has(id)).length;
  removeFromSelection(ids);
  notice(overlap > 0 ? `Убрано из выделения: ${overlap}.` : 'Отобранных мыслей в выделении нет.');
}

/** «Изменить тип…»: the searchable type picker, «Без типа» clears the type. */
async function cmdChangeType(ctx: FilterCommandsContext): Promise<void> {
  const typeId = await pickThoughtType(null);
  if (typeId === undefined) return; // cancelled
  if (typeId === null) await cmdBatch(ctx, 'clear_type', {});
  else await cmdBatch(ctx, 'set_type', { type_id: typeId });
}

/** Anchors of a link command after the picker (new thoughts already created). */
interface AnchorsPick {
  ids: string[];
  /** Link type for the links the command creates (`null` = untyped). */
  linkTypeId: string | null;
}

/**
 * Opens the anchor picker («Родительские»/«Подчинённые мысли»). With
 * `allowCreate` the dialog also offers creating new thoughts (the chosen
 * thought type applies to them only) and picking the link type for the links
 * the command will create; the picked new thoughts are created right here,
 * so the returned ids are all existing. `null` — cancelled or nothing picked.
 */
async function pickAnchors(
  dir: 'parents' | 'children',
  applyLabel: string,
  allowCreate: boolean,
): Promise<AnchorsPick | null> {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const result = await pickThoughtsDialog({
    networkId,
    allowCreate,
    allowLinkType: allowCreate,
    title: dir === 'parents' ? 'Родительские мысли' : 'Подчинённые мысли',
    applyLabel,
  });
  if (result === null) return null;
  const ids: string[] = [];
  let created = 0;
  let failed = 0;
  for (const item of result.items) {
    if (item.kind === 'existing') {
      ids.push(item.id);
      continue;
    }
    try {
      // A new anchor is linked to the filter result by the batch command
      // itself — created here without an inline link.
      const thought = await etn.thoughts.create(networkId, {
        title: item.title,
        synonyms: item.synonyms,
        type_id: result.thoughtTypeId,
      });
      ids.push(thought.id);
      created++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    notice(`Не удалось создать ${failed} новых мыслей — они пропущены.`, 'error');
  }
  if (created > 0) notice(`Создано новых мыслей: ${created}.`);
  if (ids.length === 0) return null;
  return { ids, linkTypeId: allowCreate ? result.linkTypeId : null };
}

/** «Добавить родительские/подчинённые мысли…»: pick anchors, link them. */
async function cmdLinkAnchors(
  ctx: FilterCommandsContext,
  dir: 'parents' | 'children',
): Promise<void> {
  const anchors = await pickAnchors(dir, 'Добавить', true);
  if (anchors === null) return;
  if (dir === 'parents') {
    await cmdBatch(ctx, 'link_parents', {
      parent_ids: anchors.ids,
      link_type_id: anchors.linkTypeId,
    });
  } else {
    await cmdBatch(ctx, 'link_children', {
      child_ids: anchors.ids,
      link_type_id: anchors.linkTypeId,
    });
  }
}

/** «Сделать единственными родителями…»: destructive, confirmed. */
async function cmdOnlyParents(ctx: FilterCommandsContext): Promise<void> {
  const anchors = await pickAnchors('parents', 'Выбрать', true);
  if (anchors === null) return;
  await cmdBatch(
    ctx,
    'set_only_parents',
    { parent_ids: anchors.ids, link_type_id: anchors.linkTypeId },
    {
      confirmTitle: 'Сделать единственными родителями',
      confirmText: (n) =>
        `У ${n} отобранных мыслей будут удалены все входящие связи, кроме связей ` +
        `с выбранными мыслями (${anchors.ids.length}). Продолжить?`,
    },
  );
}

/** «Разорвать связи…»: pick anchors, drop their links, confirmed. */
async function cmdUnlinkAnchors(
  ctx: FilterCommandsContext,
  dir: 'parents' | 'children',
): Promise<void> {
  // Destructive command: no new thoughts, no type picking (§15.3.1).
  const anchors = await pickAnchors(dir, 'Разорвать', false);
  if (anchors === null) return;
  const title =
    dir === 'parents' ? 'Разорвать связи с родителями' : 'Разорвать связи с подчинёнными';
  await cmdBatch(
    ctx,
    dir === 'parents' ? 'unlink_parents' : 'unlink_children',
    dir === 'parents' ? { parent_ids: anchors.ids } : { child_ids: anchors.ids },
    {
      confirmTitle: title,
      confirmText: (n) =>
        `У ${n} отобранных мыслей будут удалены связи с выбранными мыслями ` +
        `(${anchors.ids.length}). Продолжить?`,
    },
  );
}

/** «Удалить»: confirmed batch delete (protected HOME surfaces as a failure). */
async function cmdDelete(ctx: FilterCommandsContext): Promise<void> {
  await cmdBatch(ctx, 'delete', {}, {
    confirmTitle: 'Удалить мысли',
    confirmText: (n) => `Удалить ${n} отобранных мыслей?`,
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Confirmation of a destructive command: title + count-aware question. */
interface CommandConfirm {
  confirmTitle: string;
  confirmText: (count: number) => string;
}

/**
 * Runs a server batch command over the whole applied filter: collect ids,
 * confirm when destructive, one `thoughts.batch` call, report and refresh.
 */
async function cmdBatch(
  ctx: FilterCommandsContext,
  op: ThoughtBatchOp,
  args: ThoughtBatchArgs,
  confirm?: CommandConfirm,
): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let ids: string[];
  try {
    ids = await collectAllIds(ctx);
  } catch (err) {
    errorDialog('Команды отбора', err);
    return;
  }
  if (ids.length === 0) {
    notice('Отбор пуст — команда не применена.');
    return;
  }
  if (confirm !== undefined) {
    const ok = await confirmDialog(confirm.confirmTitle, confirm.confirmText(ids.length), true);
    if (!ok) return;
  }
  try {
    const result = await etn.thoughts.batch(networkId, { ids, op, args });
    if (result.failures.length > 0) {
      notice(
        `Не удалось применить к ${result.failures.length} из ${ids.length} мыслей ` +
          `(${result.failures[0]?.message ?? ''}).`,
        'error',
      );
    } else {
      notice(`Применено к ${result.affected} мыслям.`);
    }
  } catch (err) {
    errorDialog('Команды отбора', `Не удалось выполнить команду: ${errText(err)}`);
    return;
  }
  ctx.refresh();
}
