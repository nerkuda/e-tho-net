/**
 * Диалог фильтра типов связей на карте (задача «Фильтр типов связей на карте
 * мыслей», 0.8.1, элемент интерфейса «Диалог фильтра типов связей на карте»).
 *
 * Открывается кнопкой-воронкой в полосе отборов (`focus-filter-strip.ts`),
 * справа от «+». Позволяет пользователю ограничить типы связей, видимые на
 * холсте: и состав зон (родители/дети/родственники), и сами рёбра — сервер
 * применяет тот же `link_filter`, что и обход графа (`etn.thoughts.focus`),
 * резолвя его из сохранённого предпочтения пользователя (`PREF_KEY.
 * CANVAS_LINK_FILTER`) или из живого дефолта по `show_on_map`, когда
 * предпочтение не задано (см. `resolveCanvasLinkFilter` на сервере).
 *
 * Строка «Структура (Родители/Потомки)» — синтетическая: у структурных
 * связей нет типа в реестре, их присутствие в фильтре кодируется отдельным
 * флагом `include_structural`. По умолчанию отмечена.
 */

import type { LinkTypeFilterInput, NetworkProperty } from '@etn/shared';
import { PREF_KEY, computeDefaultCanvasLinkFilter, parseStoredCanvasLinkFilter } from '@etn/shared';

import { refreshFocus } from '../app.js';
import { showDialog, type DialogButton } from '../lib/dialog.js';
import { clear, div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { orderedTypeRows } from '../lib/type-tree.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** Synthetic row id for the structural («Родители»/«Потомки») checkbox —
 *  never a real link-type id, so it can share the same `checked` set. */
const STRUCTURAL_ROW_ID = '__structural__';
const STRUCTURAL_LABEL = 'Структура (Родители/Потомки)';

interface FilterRow {
  id: string;
  label: string;
  depth: number;
}

/** Opens the dialog. Fetches the current preference + property registry
 *  fresh on every open — infrequent action, no need to cache. */
export function openCanvasLinkFilterDialog(networkId: string): void {
  void loadAndOpen(networkId);
}

async function loadAndOpen(networkId: string): Promise<void> {
  let properties: NetworkProperty[];
  let storedRaw: unknown;
  try {
    const [propsResp, prefs] = await Promise.all([
      etn.propertyRegistry.list(networkId),
      etn.networks.getPreferences(networkId),
    ]);
    properties = propsResp;
    storedRaw = prefs.find((p) => p.key === PREF_KEY.CANVAS_LINK_FILTER)?.value;
  } catch (err) {
    notice(formatError(err, 'Не удалось загрузить фильтр типов связей.'), 'error');
    return;
  }
  const defaultFilter = computeDefaultCanvasLinkFilter(properties);
  const stored = parseStoredCanvasLinkFilter(storedRaw);
  const initial = stored ?? defaultFilter;

  const rows: FilterRow[] = [
    { id: STRUCTURAL_ROW_ID, label: STRUCTURAL_LABEL, depth: 0 },
    ...orderedTypeRows(store.state.linkTypes)
      .filter((row) => !row.type.is_root)
      .map((row) => ({ id: row.type.id, label: row.type.name_forward, depth: row.depth - 1 })),
  ];

  const checked = new Set<string>(initial.type_ids ?? []);
  if (initial.include_structural === true) checked.add(STRUCTURAL_ROW_ID);

  const body = div('st-f-picker');
  const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Найти…';

  const toolbar = div('link-filter-toolbar');
  const markAllBtn = el('button', 'st-f-clear', 'Пометить все') as HTMLButtonElement;
  const clearAllBtn = el('button', 'st-f-clear', 'Снять все пометки') as HTMLButtonElement;
  const restoreBtn = el('button', 'st-f-clear', 'Вернуть умолчания') as HTMLButtonElement;
  markAllBtn.type = 'button';
  clearAllBtn.type = 'button';
  restoreBtn.type = 'button';
  toolbar.append(markAllBtn, clearAllBtn, restoreBtn);

  const list = div('st-f-checks st-f-picker-list link-filter-list');

  let applyBtnEl: HTMLButtonElement | null = null;
  const updateApplyState = (): void => {
    if (applyBtnEl !== null) applyBtnEl.disabled = checked.size === 0;
  };

  const renderList = (needle: string): void => {
    clear(list);
    const filtered = rows.filter((row) => row.label.toLowerCase().includes(needle));
    if (filtered.length === 0) {
      list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
      return;
    }
    for (const row of filtered) {
      const line = el('label', 'st-f-check');
      line.style.paddingLeft = `${Math.max(0, row.depth) * 14}px`;
      const input = el('input') as HTMLInputElement;
      input.type = 'checkbox';
      input.checked = checked.has(row.id);
      input.addEventListener('change', () => {
        if (input.checked) checked.add(row.id);
        else checked.delete(row.id);
        updateApplyState();
      });
      line.append(input, el('span', '', row.label));
      list.append(line);
    }
  };
  renderList('');
  searchInput.addEventListener('input', () => {
    renderList(searchInput.value.trim().toLowerCase());
  });

  markAllBtn.addEventListener('click', () => {
    for (const row of rows) checked.add(row.id);
    renderList(searchInput.value.trim().toLowerCase());
    updateApplyState();
  });
  clearAllBtn.addEventListener('click', () => {
    checked.clear();
    renderList(searchInput.value.trim().toLowerCase());
    updateApplyState();
  });
  restoreBtn.addEventListener('click', () => {
    checked.clear();
    for (const id of defaultFilter.type_ids ?? []) checked.add(id);
    if (defaultFilter.include_structural === true) checked.add(STRUCTURAL_ROW_ID);
    renderList(searchInput.value.trim().toLowerCase());
    updateApplyState();
  });

  body.append(searchInput, toolbar, list);

  const buttons: DialogButton[] = [
    { label: 'Отмена' },
    {
      label: 'Применить и закрыть',
      primary: true,
      keepOpen: true,
      ref: (btn) => {
        applyBtnEl = btn;
        updateApplyState();
      },
      onClick: (close) => {
        void applyFilter(networkId, checked, close);
      },
    },
  ];

  showDialog({
    title: 'Фильтр типов связей на карте',
    body,
    width: 480,
    buttons,
    onMount: () => searchInput.focus(),
  });
}

async function applyFilter(
  networkId: string,
  checked: ReadonlySet<string>,
  close: () => void,
): Promise<void> {
  // Guard is also enforced by disabling the button, but a defensive check
  // here keeps the invariant even if the dialog is driven programmatically —
  // an empty `{ type_ids: [], include_structural: false }` is rejected by the
  // server as an invalid `link_filter` (see requirement «Дефолт и хранение
  // фильтра типов связей на карте»).
  if (checked.size === 0) {
    notice('Оставьте хотя бы один тип связи.', 'error');
    return;
  }
  const includeStructural = checked.has(STRUCTURAL_ROW_ID);
  const typeIds = [...checked].filter((id) => id !== STRUCTURAL_ROW_ID);
  const value: LinkTypeFilterInput = { include_structural: includeStructural };
  if (typeIds.length > 0) value.type_ids = typeIds;
  try {
    await etn.networks.setPreference(networkId, PREF_KEY.CANVAS_LINK_FILTER, value);
    store.update({ canvasLinkFilter: value });
    close();
    await refreshFocus();
  } catch (err) {
    notice(formatError(err, 'Не удалось сохранить фильтр типов связей.'), 'error');
  }
}

function formatError(err: unknown, fallback: string): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return `${fallback} ${msg}`;
  }
  return fallback;
}
