/**
 * Секция сортировки редактора отбора (задача c74f17a0 ТП 11b2509a «Редактор:
 * базовый компонент»; элемент интерфейса 3f0bf221 «Секция сортировки отбора»;
 * требования 3e47f52a «многоуровневая, направление на каждый ключ», 8334b54a
 * «набор полей общий с конструктором»).
 *
 * Секция — список чипов `[поле ↑/↓]` и кнопка «+» добавления ключа: сортировка
 * многоуровневая, направление задаётся НА КАЖДЫЙ ключ, порядок применения —
 * порядок чипов. Сортировка — отдельное поле отбора (не узел AST): модель
 * хранит её в `FilterCriteriaState.sortKeys` (`{ key, order }`), второго
 * хранилища и второго набора сортировок нет.
 *
 * Словарь доступных полей общий с конструктором: движковые ключи даёт
 * `filterSortAstKeys()` единого набора (`FILTER_SORTS`), ключи-свойства — реестр
 * сети и обе стороны свойств-связей (тот же расширенный реестр, из которого
 * собирается список «Что» дерева). Благодаря этому «исполнитель принимает всё,
 * что позволил редактор».
 *
 * Диагностика ядра адресует ключ как `sort[i]` (требование 3e47f52a): чип с
 * удалённым/несуществующим свойством помечается красным с точной причиной —
 * секция получает записи через `issues`.
 *
 * Вид — из дизайн-системы (кнопки `uiButton`/`iconButton`, выпадающий список
 * выбора — общий `openChoiceMenu` дерева); свой CSS — только роли чипа
 * (`styles/filter-editor.css`).
 */

import {
  type FilterAstSortKey,
  type LinkType,
  type NetworkProperty,
  type PropertyValueType,
  type SortOrder,
} from '@etn/shared';

import { clear, div, el, span } from './dom.js';
import {
  filterIssuesByPath,
  filterIssueReason,
  type FilterIssue,
} from './filter-diagnostics.js';
import { filterSortAstKeys, isSortOrder, withReverseLinkPropertySides } from './filter-builder.js';
import { openChoiceMenu } from './filter-tree.js';
import { VALUE_TYPE_LABELS } from './property-list.js';
import { iconButton, uiButton } from './ui/button.js';
import { svgIcon } from './ui/icon.js';

export const FILTER_SORT_SECTION_CLASS = 'fs-sort';
export const FILTER_SORT_CHIP_CLASS = 'fs-chip';

/** Глифы направления — единственное место их начертания (↑ возрастание, ↓ убывание). */
export const FILTER_SORT_ORDER_GLYPHS: Readonly<Record<SortOrder, string>> = {
  asc: '↑',
  desc: '↓',
};

/** Подписи направления (подсказки кнопки чипа). */
export const FILTER_SORT_ORDER_LABELS: Readonly<Record<SortOrder, string>> = {
  asc: 'возрастание',
  desc: 'убывание',
};

/** Одно доступное поле сортировки. */
export interface FilterSortKeyOption {
  /** Ключ AST: движковый код или адрес свойства сети. */
  key: string;
  label: string;
  /** Раздел словаря: движковые ключи / свойства реестра. */
  group: 'engine' | 'properties';
  /** Природа свойства — подпись подробности в списке выбора. */
  valueType?: PropertyValueType;
  detail?: string;
}

/** Данные сети для словаря ключей (реестр свойств + типы связей). */
export interface FilterSortData {
  registry: ReadonlyMap<string, NetworkProperty>;
  linkTypes?: readonly LinkType[];
}

/** Параметры секции сортировки. */
export interface FilterSortSectionOptions {
  /** Текущие ключи — из единой модели (`FilterCriteriaState.sortKeys`). */
  getKeys: () => readonly FilterAstSortKey[];
  /** Запись ключей в модель хоста (единственный путь правки). */
  setKeys: (keys: FilterAstSortKey[]) => void;
  /** Словарь полей — функция (реестр сети живой). */
  options: () => readonly FilterSortKeyOption[];
  /** Данные сети — для подписей ключей-свойств. */
  data: FilterSortData;
  /** Заголовок секции; по умолчанию «Сортировка». */
  title?: string;
  /** Записи диагностики: красная по пути `sort[i]` помечает чип. */
  issues?: () => readonly FilterIssue[];
  /** Сообщить хосту об изменении (маркер «изменён», персист). */
  onChange?: () => void;
}

/** Рукоятка секции сортировки. */
export interface FilterSortSectionHandle {
  root: HTMLElement;
  /** Перерисовать чипы из модели. */
  rerender: () => void;
}

// ---------------------------------------------------------------------------
// Единый словарь ключей
// ---------------------------------------------------------------------------

/**
 * Словарь полей сортировки: движковые ключи единого набора конструктора плюс
 * свойства реестра сети и обратные стороны свойств-связей. Второго набора
 * сортировок нет (сторож `guard-filter-builder`).
 */
export function filterSortKeyOptions(data: FilterSortData): FilterSortKeyOption[] {
  const out: FilterSortKeyOption[] = filterSortAstKeys().map((entry) => ({
    key: entry.key,
    label: entry.label,
    group: 'engine' as const,
  }));
  const registry = withReverseLinkPropertySides(data.registry, data.linkTypes ?? []);
  for (const [id, entry] of registry) {
    const direct = data.registry.has(id);
    out.push({
      key: id,
      label: entry.name,
      group: 'properties',
      valueType: entry.value_type,
      detail: direct
        ? VALUE_TYPE_LABELS[entry.value_type]
        : `${VALUE_TYPE_LABELS[entry.value_type]} · обратная сторона`,
    });
  }
  return out;
}

/** Подпись ключа сортировки: движковый — из конструктора, свойство — из реестра. */
export function filterSortKeyLabel(
  key: string,
  data: FilterSortData,
  options?: readonly FilterSortKeyOption[],
): string {
  const list = options ?? filterSortKeyOptions(data);
  return list.find((entry) => entry.key === key)?.label ?? key;
}

/** Подсказка чипа: «поле · направление» (порядок применения — порядок чипов). */
export function filterSortChipTitle(key: string, order: SortOrder, label: string): string {
  return `${label} · ${FILTER_SORT_ORDER_LABELS[order]} · порядок применения — порядок чипов`;
}

/** Следующее направление ключа по клику (направление задаётся на каждый ключ). */
export function nextSortOrder(order: SortOrder): SortOrder {
  return order === 'asc' ? 'desc' : 'asc';
}

/** Ключи модели, очищенные до известного вида (`{ key, order }`). */
function normalizeKeys(keys: readonly FilterAstSortKey[]): FilterAstSortKey[] {
  return keys
    .filter((entry) => typeof entry.key === 'string' && entry.key !== '' && isSortOrder(entry.order))
    .map((entry) => ({ key: entry.key, order: entry.order }));
}

/**
 * Содержимое выпадающего списка добавления ключа: уже занятые ключи из списка
 * убираются (уровни сортировки — различные поля), разделы «поля отбора» и
 * «свойства сети» сохраняют порядок единого словаря. Вынесено отдельно, чтобы
 * список проверялся DOM-пробой без открытия поповера.
 */
export function filterSortAddMenu(
  keys: readonly FilterAstSortKey[],
  options: readonly FilterSortKeyOption[],
): {
  title: string;
  search: boolean;
  placeholder: string;
  groups: Array<{ label: string; items: Array<{ key: string; label: string }> }>;
} {
  const used = new Set(normalizeKeys(keys).map((entry) => entry.key));
  const available = options.filter((entry) => !used.has(entry.key));
  const pick = (group: FilterSortKeyOption['group']) =>
    available
      .filter((entry) => entry.group === group)
      .map((entry) => ({ key: entry.key, label: entry.label }));
  return {
    title: 'Ключ сортировки',
    search: true,
    placeholder: 'Поиск поля…',
    groups: [
      { label: 'Поля отбора', items: pick('engine') },
      { label: 'Свойства сети', items: pick('properties') },
    ].filter((group) => group.items.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------

/** Собрать секцию сортировки над единой моделью хоста. */
export function buildFilterSortSection(opts: FilterSortSectionOptions): FilterSortSectionHandle {
  const root = div(FILTER_SORT_SECTION_CLASS);
  root.append(el('div', 'fs-sort__head', opts.title ?? 'Сортировка'));

  const chipsRow = div('fs-sort__chips');
  root.append(chipsRow);

  /** Записать ключи в модель и перерисовать (единственный путь правки). */
  const commit = (keys: FilterAstSortKey[]): void => {
    opts.setKeys(normalizeKeys(keys));
    opts.onChange?.();
    rerender();
  };

  const addKey = (key: string): void => {
    const keys = normalizeKeys(opts.getKeys());
    if (keys.some((entry) => entry.key === key)) return;
    commit([...keys, { key, order: 'asc' }]);
  };

  const openAddMenu = (anchor: HTMLElement): void => {
    openChoiceMenu(anchor, {
      ...filterSortAddMenu(opts.getKeys(), opts.options()),
      onPick: (key) => addKey(key),
    });
  };

  function rerender(): void {
    clear(chipsRow);
    const keys = normalizeKeys(opts.getKeys());
    const byPath = filterIssuesByPath(opts.issues?.() ?? []);
    keys.forEach((entry, index) => {
      const label = filterSortKeyLabel(entry.key, opts.data, opts.options());
      const chip = div(FILTER_SORT_CHIP_CLASS);
      chip.dataset['key'] = entry.key;
      chip.dataset['order'] = entry.order;
      const issue = byPath.get(`sort[${index}]`);
      if (issue !== undefined) {
        chip.dataset['severity'] = issue.severity;
        chip.classList.add(`${FILTER_SORT_CHIP_CLASS}--${issue.severity}`);
      }
      chip.append(span(label, 'fs-chip__label'));
      chip.append(
        uiButton({
          label: FILTER_SORT_ORDER_GLYPHS[entry.order],
          role: 'ghost',
          size: 's',
          class: 'fs-chip__order',
          title: `направление: ${FILTER_SORT_ORDER_LABELS[entry.order]} — нажмите, чтобы сменить`,
          onClick: () =>
            commit(
              keys.map((current, i) =>
                i === index ? { key: current.key, order: nextSortOrder(current.order) } : current,
              ),
            ),
        }),
        iconButton({
          icon: svgIcon('x'),
          title: 'Убрать ключ сортировки',
          role: 'ghost',
          size: 's',
          class: 'fs-chip__remove',
          onClick: () => commit(keys.filter((_, i) => i !== index)),
        }),
      );
      // Причина диагностики — тем же текстом, что у строк дерева (код ядра,
      // снапшот имени и дата): «исправить» на чипе — это его снятие или замена.
      chip.title = issue === undefined
        ? filterSortChipTitle(entry.key, entry.order, label)
        : `${filterIssueReason(issue)} (${filterSortChipTitle(entry.key, entry.order, label)})`;
      chipsRow.append(chip);
    });

    const addButton = uiButton({
      label: '+',
      role: 'ghost',
      size: 's',
      class: 'fs-add',
      title: 'Добавить ключ сортировки',
      onClick: () => openAddMenu(addButton),
    });
    chipsRow.append(addButton);
  }

  rerender();
  return { root, rerender };
}
