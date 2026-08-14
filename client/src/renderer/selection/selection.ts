/**
 * Selection panel (H16, 08-ui-spec.md §5; 09-scenarios.md E).
 *
 * - Ctrl+click toggles a cloud in the selection; Ctrl+click on an ellipse adds
 *   all parents/children of that thought;
 * - panel (left) appears while the selection is non-empty: list of titles,
 *   «Добавить» (children/parents of everything selected), «Изменить» (type,
 *   activity, delete, link to focus, clear), «Экспортировать» (markdown/html/
 *   pdf via the async job API + polling download);
 * - group operations go through `thoughts.batch`.
 */

import { scheduleRefresh, requireNetworkId } from '../app.js';
import { setAddToSelectionHook } from '../canvas/context-menu.js';
import { applyThoughtIcon, setSelectionClickHooks } from '../canvas/canvas.js';
import { confirmDialog, errorDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { MENU_SEPARATOR, showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import type { ExportFormat, ThoughtRef } from '@etn/shared';

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
  listHost = div('selection-list');
  const actions = div('selection-actions');
  actions.append(
    button('Добавить', () => void openAddMenu(actions), 'btn small'),
    button('Изменить', () => void openEditMenu(actions), 'btn small'),
    button('Экспортировать', () => void openExportMenu(actions), 'btn small'),
  );
  host.append(header, listHost, actions);

  // Ctrl+click wiring (spec §5.1).
  setAddToSelectionHook((id) => toggleSelection([id]));
  setSelectionClickHooks({
    onCloudClick: (id) => toggleSelection([id]),
    onEllipseClick: (id, direction) => void addNeighborsOf(id, direction),
  });

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
  let refs = new Map<string, ThoughtRef>();
  try {
    const resolved = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    refs = new Map(resolved.map((r) => [r.id, r]));
  } catch {
    // ids shown as-is
  }
  listHost.replaceChildren();
  for (const id of ids) {
    const item = div('selection-item');
    const iconBox = span('');
    const ref = refs.get(id);
    if (ref !== undefined) {
      applyThoughtIcon(iconBox, ref);
    } else {
      iconBox.textContent = '💭';
    }
    item.append(iconBox);
    const title = el('span', 'sel-title', refs.get(id)?.title ?? id);
    item.append(title);
    item.append(
      button(
        '✕',
        () => {
          toggleSelection([id]);
        },
        'btn small',
        'Убрать из выделения',
      ),
    );
    item.addEventListener('click', () => {
      // click on title focuses; ✕ stops propagation via its own handler
      void etn.thoughts
        .focus(networkId, id)
        .then(() => undefined)
        .catch(() => undefined);
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

/** Adds ids without deduplication (spec §5.1: duplicates are fine). */
export function addToSelection(ids: string[]): void {
  if (ids.length === 0) return;
  store.update({ selection: [...store.state.selection, ...ids] });
}

/** Clears the selection list. */
function clearSelection(): void {
  store.update({ selection: [] });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** «Добавить» menu: children/parents of everything selected. */
async function openAddMenu(anchor: HTMLElement): Promise<void> {
  const items: MenuItem[] = [
    {
      label: 'добавить назначения связей (детей)',
      onClick: () => void addNeighborsOfAll('children'),
    },
    {
      label: 'добавить источники связей (родителей)',
      onClick: () => void addNeighborsOfAll('parents'),
    },
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.top - 76, items);
}

/** «Изменить» menu: batch operations. */
function openEditMenu(anchor: HTMLElement): void {
  const focusId = store.state.focus?.focused.id;

  const typeItems: MenuItem[] = store.state.thoughtTypes.map((type) => ({
    label: type.name,
    onClick: () => void batch({ op: 'set_type', args: { type_id: type.id } }),
  }));
  typeItems.push({
    label: 'очистить тип',
    onClick: () => void batch({ op: 'clear_type', args: {} }),
  });

  const items: MenuItem[] = [
    { label: 'изменить тип', submenu: typeItems },
    {
      label: 'сделать неактивными',
      onClick: () => void batch({ op: 'set_inactive', args: { active: false } }),
    },
    {
      label: 'сделать активными',
      onClick: () => void batch({ op: 'set_active', args: { active: true } }),
    },
    {
      label: 'удалить',
      danger: true,
      onClick: () => void batchDelete(),
    },
    MENU_SEPARATOR,
    {
      label: 'сделать источниками для фокуса',
      disabled: focusId === undefined,
      onClick: () =>
        void batch({
          op: 'link_to_focus',
          args: { focus_thought_id: focusId, direction: 'parent' },
        }),
    },
    {
      label: 'сделать назначениями для фокуса',
      disabled: focusId === undefined,
      onClick: () =>
        void batch({
          op: 'link_to_focus',
          args: { focus_thought_id: focusId, direction: 'child' },
        }),
    },
    MENU_SEPARATOR,
    {
      label: 'очистить список',
      onClick: () => clearSelection(),
    },
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.top - items.length * 32 - 8, items);
}

/** «Экспортировать» menu: format → async job → poll → download. */
function openExportMenu(anchor: HTMLElement): void {
  const formats: ExportFormat[] = ['markdown', 'html', 'pdf'];
  const items: MenuItem[] = formats.map((format) => ({
    label: format === 'markdown' ? 'Markdown' : format.toUpperCase(),
    onClick: () => void runExport(format),
  }));
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.top - 112, items);
}

// ---------------------------------------------------------------------------
// Operations
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

/** Adds children/parents of one thought to the selection (Ctrl+ellipse). */
async function addNeighborsOf(id: string, direction: 'parent' | 'child'): Promise<void> {
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
