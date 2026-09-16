/**
 * Унифицированный пикер типов мыслей/связей (задача 2ee1efdf — вынос дубля
 * из `filter-panel.ts` и `filter-dialog.ts` в общий модуль; инструкция
 * a47947c8 — единые поля выбора ссылок).
 *
 * Возвращает массив id — подмножество переданного `currentIds`, к которому
 * пользователь применил отметки чек-листа (или новый набор, если был
 * предзаполнен). `null` означает отмену. Сценарий «несколько типов»: чип-поле
 * хранит «managed»-часть (id без `$…`-токенов) и зовёт пикер для редактирования
 * именно её, после применения — заменяет её на новый набор, не трогая токены.
 *
 * Используется:
 *   - `filter-panel.ts` (обход графа): открывает пикер напрямую;
 *   - `filter-dialog.ts` (отбор типа мысли): пикер встроен в chip-поле;
 *   - `property-manager.ts` (редактор свойства/связи): выбор типов для
 *     привязки «Типы источников»/«Типы назначений»/«Типы мыслей» —
 *     унифицированный сценарий, без `window.prompt`.
 */

import type { LinkType, ThoughtType } from '@etn/shared';

import { showDialog } from './dialog.js';
import { clear, div, el } from './dom.js';
import { etn } from './etn.js';
import { store } from '../state.js';
import { orderedTypeRows } from './type-tree.js';

/** Minimum column width of a checklist, px (must match the CSS column-gap). */
const CHECK_COL_W = 85;
/** Column gap of the checklist, px. */
const CHECK_COL_GAP = 14;
/** Fixed height of one checklist row, px (must match the CSS row height). */
const CHECK_ROW_H = 22;

/**
 * Recomputes the column count of a checklist for its current height and width:
 * as many columns as fit the dialog width; when the items need more columns
 * than that, the last column overflows downward and the list scrolls
 * vertically (`column-fill: auto`).
 */
function applyCheckColumns(list: HTMLElement): void {
  const rowsPerCol = Math.max(1, Math.floor(list.clientHeight / CHECK_ROW_H));
  const needed = Math.ceil(list.children.length / rowsPerCol);
  const maxCols = Math.max(
    1,
    Math.floor((list.clientWidth + CHECK_COL_GAP) / (CHECK_COL_W + CHECK_COL_GAP)),
  );
  const count = Math.max(1, Math.min(needed, maxCols));
  list.style.columnCount = String(count);
  list.style.columnFill = needed > count ? 'auto' : 'balance';
}

export type TypeKind = 'thought' | 'link';

interface PickerRow {
  id: string;
  label: string;
  depth: number;
}

/**
 * Открывает модальный мульти-пикер типов мыслей: поиск по подстроке,
 * многоколоночный чек-лист (отмеченные сверху, потом алфавит), «Отмена» /
 * «Применить». Возвращает новый набор id или `null` при отмене. Каталог
 * берётся из `store.state.thoughtTypes`; если он пуст — догружается через
 * `etn.types.listThoughtTypes` (актуально при первом открытии до realtime).
 */
export async function openThoughtTypesPicker(
  networkId: string,
  currentIds: readonly string[],
): Promise<string[] | null> {
  let types: ThoughtType[] = store.state.thoughtTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listThoughtTypes(networkId);
    } catch {
      types = [];
    }
  }
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name, depth: row.depth - 1 }));
  return openTypePickerDialog('Типы мыслей', rows, currentIds);
}

/**
 * То же для типов связей. Названия в пикере — `name_forward`, как и в дереве
 * типов связей.
 */
export async function openLinkTypesPicker(
  networkId: string,
  currentIds: readonly string[],
): Promise<string[] | null> {
  let types: LinkType[] = store.state.linkTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listLinkTypes(networkId);
    } catch {
      types = [];
    }
  }
  // Separate branch keeps `orderedTypeRows`'s generic bound to one concrete
  // type — a union array (`ThoughtType[] | LinkType[]`) fails inference.
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({
      id: row.type.id,
      label: row.type.name_forward ?? '',
      depth: row.depth - 1,
    }));
  return openTypePickerDialog('Типы связей', rows, currentIds);
}

/**
 * Базовая модалка пикера типов: поиск по подстроке + многоколоночный
 * чек-лист (отмеченные сверху, потом алфавит) + кнопка «Очистить» +
 * «Отмена»/«Применить». Колонки раскладываются по ширине контейнера
 * (`column-fill: auto`, ширина колонки фиксирована). На Apply возвращает
 * новый набор id, на Cancel/Esc/backdrop — `null`.
 *
 * Экспортируется, чтобы экраны со специфическим заголовком пикера
 * (например, фильтр обхода графа «Обход по связям» в `filter-panel.ts`)
 * могли переиспользовать тот же модальный каркас.
 */
export function openTypePickerDialog(
  title: string,
  rows: PickerRow[],
  initial: readonly string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const checked = new Set(initial);
    let needle = '';
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = div('st-f-picker');
    const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.placeholder = 'Найти…';
    const list = div('st-f-checks st-f-picker-list');
    const clearBtn = el('button', 'st-f-clear', 'Очистить') as HTMLButtonElement;
    clearBtn.type = 'button';

    const renderList = (): void => {
      clear(list);
      const filtered = rows.filter((row) => row.label.toLowerCase().includes(needle));
      const byAlpha = (a: PickerRow, b: PickerRow): number => a.label.localeCompare(b.label, 'ru');
      const sorted = [
        ...filtered.filter((row) => checked.has(row.id)).sort(byAlpha),
        ...filtered.filter((row) => !checked.has(row.id)).sort(byAlpha),
      ];
      if (sorted.length === 0) list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
      for (const row of sorted) {
        const line = el('label', 'st-f-check');
        line.style.paddingLeft = `${Math.max(0, row.depth) * 14}px`;
        const input = el('input') as HTMLInputElement;
        input.type = 'checkbox';
        input.checked = checked.has(row.id);
        input.addEventListener('change', () => {
          if (input.checked) checked.add(row.id);
          else checked.delete(row.id);
          clearBtn.disabled = checked.size === 0;
          renderList();
        });
        line.append(input, el('span', '', row.label));
        list.append(line);
      }
      if (list.isConnected) applyCheckColumns(list);
      else requestAnimationFrame(() => applyCheckColumns(list));
    };
    searchInput.addEventListener('input', () => {
      needle = searchInput.value.trim().toLowerCase();
      renderList();
    });
    clearBtn.disabled = checked.size === 0;
    clearBtn.addEventListener('click', () => {
      checked.clear();
      renderList();
      clearBtn.disabled = true;
    });
    body.append(searchInput, list, clearBtn);

    showDialog({
      title,
      body,
      width: 480,
      buttons: [
        { label: 'Отмена', onClick: () => finish(null) },
        { label: 'Применить', primary: true, onClick: () => finish([...checked]) },
      ],
      onMount: () => {
        renderList();
        searchInput.focus();
      },
    });
  });
}
