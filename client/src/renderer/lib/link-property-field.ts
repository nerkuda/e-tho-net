/**
 * Поле выбора свойства-связи с живым поиском — переиспользуемый компонент
 * (ошибка dc175a5b, версия 0.8.3; поле введено коммитом 0d9485d по ошибке
 * 1dd08949).
 *
 * **Зачем отдельный модуль.** Поле понадобится не только диалогу добавления
 * мысли с карты: пользователь выбирает СВОЙСТВО-связь (имя его стороны), а не
 * тип связи, в разных местах. Поэтому модель вариантов и поле живут здесь, а
 * потребитель передаёт только строки общего списка свойств
 * (`lib/property-list.ts` — единственный владелец реестровых строк, значков
 * концов связи и их поиска).
 *
 * **Поле — ввод с живым поиском, а не «открывашка».** Разметка — обычное поле
 * ввода, список — общая выпадашка подсказок (`wireSuggest`, ADR «одна
 * выпадашка-подсказчик»); собственной сборки списка здесь нет (сторож
 * `guard-suggest-dropdown`).
 *
 * **Что видно в списке.** Пункт «без свойства» (бестиповая связь в направлении
 * диалога) и по одному пункту на КАЖДОЕ имя стороны свойства-связи: значок
 * конца связи (направление + эффективное оформление линии, `buildLinkEndIcon`
 * общего списка), имя стороны и серое уточнение «сторона · связь (прямое -
 * обратное)» — то же оформление, что в списке выбора свойства при
 * редактировании типов мыслей.
 *
 * **Живой поиск** идёт тем же фильтром, что у общего списка свойств: совпадение
 * по имени стороны, по любому из имён пары типа связи или по описанию
 * (`filterPropertyListRows`).
 *
 * **Значение.** Выбранное имя стороны — `key` записи (`properties.set`):
 * сервер по имени сам выводит свойство и направление ребра.
 */

import type { LinkPropertySide } from '@etn/shared';

import { div, el } from './dom.js';
import {
  filterPropertyListRows,
  linkEndIconSpec,
  sortPropertyListRows,
  valueTypeCellLabel,
  type LinkEndIconSpec,
  type PropertyListRow,
} from './property-list.js';
import { wireSuggest, type SuggestEntry, type SuggestHandle, type SuggestSource } from './suggest-dropdown.js';

/** Подпись пункта «свойство не выбрано» (бестиповая связь в направлении диалога). */
export const LINK_PROPERTY_NONE_LABEL = 'без свойства';

/** Подписи сторон свойства-связи (как в общем списке свойств). */
const SIDE_LABELS: Record<LinkPropertySide, string> = {
  source: 'источник',
  target: 'назначение',
};

/**
 * Выбранное СВОЙСТВО-связь (ошибка 1dd08949): пользователь выбирает не тип
 * связи, а имя стороны свойства-связи — `key` (display-имя стороны) адресует
 * серверу и свойство, и направление ребра. Свойство заполняется у ДОБАВЛЯЕМОЙ
 * мысли значением якоря (мысли, от которой строится связь), так что ребро
 * попадает в типизированное свойство, а не в «Свойства вне типа».
 */
export interface LinkPropertyPick {
  /** Id реестровой записи свойства — для карточки/диагностики. */
  propertyId: string;
  /** Сторона свойства (`source` — имя прямого, `target` — обратного). */
  side: LinkPropertySide;
  /** Display-имя выбранной стороны: ключ записи (`properties.set`). Имя
   *  однозначно задаёт направление ребра (name_forward → исходящее,
   *  name_reverse → входящее). */
  key: string;
}

/**
 * Один вариант поля: строка общего списка свойств (только сторона
 * свойства-связи) плюс готовые подписи строки списка подсказок.
 */
export interface LinkPropertyOption {
  /** Ключ варианта — id строки общего списка (`<property_id>:<side>`). */
  value: string;
  /** Строка общего списка свойств, из которой собран вариант. */
  row: PropertyListRow;
  /** Подпись — имя выбранной стороны. */
  label: string;
  /** Сторона свойства. */
  side: LinkPropertySide;
  /** Подпись стороны: «источник» / «назначение». */
  sideLabel: string;
  /** Подписи имён пары типа связи («связь (прямое - обратное)»). */
  pairLabel: string;
  /** Значок конца связи: направление (зеркалирование) и оформление линии. */
  linkEnd: LinkEndIconSpec;
}

/** Вариант поля из строки общего списка: только сторона свойства-связи
 *  (скаляры и структурные «Родители»/«Потомки» в поле не выбираются). */
function optionOf(row: PropertyListRow): LinkPropertyOption | null {
  if (row.valueType !== 'link' || row.structural || row.side === null) return null;
  return {
    value: row.id,
    row,
    label: row.name,
    side: row.side,
    sideLabel: SIDE_LABELS[row.side],
    pairLabel: valueTypeCellLabel(row),
    linkEnd: linkEndIconSpec(row.side, row.visual),
  };
}

/** Все варианты поля из строк общего списка, в едином алфавитном порядке имён
 *  сторон (как строки общего списка свойств). Чистая — юнит-тест. */
export function linkPropertyOptions(rows: readonly PropertyListRow[]): LinkPropertyOption[] {
  const out: LinkPropertyOption[] = [];
  for (const row of sortPropertyListRows(rows)) {
    const option = optionOf(row);
    if (option !== null) out.push(option);
  }
  return out;
}

/**
 * Живой поиск по вариантам: тот же фильтр, что у общего списка свойств (имя
 * стороны, любое имя пары типа связи или описание), поэтому поиск находит
 * свойство и по обратному имени. Пустой запрос — все варианты. Чистая —
 * юнит-тест.
 */
export function filterLinkPropertyOptions(
  options: readonly LinkPropertyOption[],
  query: string,
): LinkPropertyOption[] {
  if (query.trim() === '') return [...options];
  return options.filter((option) => filterPropertyListRows([option.row], query).length > 0);
}

/** Строка выпадашки по варианту: значок конца связи, имя стороны и уточнение. */
function optionEntry(option: LinkPropertyOption): SuggestEntry {
  return {
    value: option.value,
    label: option.label,
    linkEnd: option.linkEnd,
    note: `${option.sideLabel} · ${option.pairLabel}`,
  };
}

/** Параметры {@link buildLinkPropertyField}. */
export interface LinkPropertyFieldOptions {
  /** Строки общего списка свойств (`buildPropertyListRows`) — источник сторон. */
  rows: readonly PropertyListRow[];
  /** Начальное значение (`null`/нет — «без свойства»). */
  value?: LinkPropertyPick | null;
  placeholder?: string;
  /** Выбор варианта; «без свойства» — `null`. */
  onChange: (pick: LinkPropertyPick | null) => void;
}

/** Собранное поле выбора свойства-связи. */
export interface LinkPropertyField {
  /** Корневой узел поля (поле ввода с живым поиском). */
  root: HTMLElement;
  /** Текущее значение (`null` — «без свойства»). */
  value: () => LinkPropertyPick | null;
  /** Заменяет строки-источники (каталог типов связей мог прийти позже). */
  setRows: (rows: readonly PropertyListRow[]) => void;
  /** Закрывает выпадашку и снимает слушатели. */
  dispose: () => void;
}

/** Ключ варианта по выбранному значению (`<propertyId>:<side>`). */
function valueOf(pick: LinkPropertyPick): string {
  return `${pick.propertyId}:${pick.side}`;
}

/**
 * Собирает поле выбора свойства-связи: поле ввода с живым поиском и общая
 * выпадашка подсказок. Пока пользователь печатает — список сужается; выбранное
 * имя стороны показано в поле текстом, повторный фокус очищает поле и снова
 * показывает весь список (потеря фокуса без выбора возвращает подпись).
 */
export function buildLinkPropertyField(opts: LinkPropertyFieldOptions): LinkPropertyField {
  let rows: readonly PropertyListRow[] = opts.rows;
  let pick: LinkPropertyPick | null = opts.value ?? null;

  const root = div('link-property-field');
  const input = el('input', 'text-input link-property-input') as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder ?? 'Найти свойство связи…';
  root.append(input);

  /** Подпись текущего выбранного значения (нет — пусто). */
  const currentLabel = (): string => {
    const chosen = pick;
    if (chosen === null) return '';
    const option = linkPropertyOptions(rows).find((o) => o.value === valueOf(chosen));
    return option?.label ?? chosen.key;
  };

  const source: SuggestSource = {
    when: 'always',
    load: (query) => {
      const entries: SuggestEntry[] = [];
      // Пункт «без свойства» — постоянная возможность снять выбор; при поиске
      // он остаётся, только пока сам подходит под запрос.
      const needle = query.trim().toLowerCase();
      if (needle === '' || LINK_PROPERTY_NONE_LABEL.includes(needle)) {
        entries.push({ value: '', label: LINK_PROPERTY_NONE_LABEL });
      }
      for (const option of filterLinkPropertyOptions(linkPropertyOptions(rows), query)) {
        entries.push(optionEntry(option));
      }
      return entries;
    },
  };

  const handle: SuggestHandle = wireSuggest(input, {
    sources: [source],
    onPick: (entry) => {
      const option = linkPropertyOptions(rows).find((o) => o.value === entry.value) ?? null;
      pick =
        option === null
          ? null
          : { propertyId: option.row.propertyId, side: option.side, key: option.label };
      input.value = option?.label ?? '';
      opts.onChange(pick);
    },
  });

  // Повторный фокус: подпись выбранного убирается, чтобы источник отдал весь
  // список (иначе фильтр оставил бы только текущую строку) — и список тут же
  // пересобирается уже по пустому запросу. Потеря фокуса без выбора возвращает
  // подпись.
  input.addEventListener('focus', () => {
    if (input.value !== currentLabel()) return;
    input.value = '';
    handle.open();
  });
  input.addEventListener('blur', () => {
    input.value = currentLabel();
  });

  input.value = currentLabel();

  return {
    root,
    value: () => pick,
    setRows: (next) => {
      rows = next;
      input.value = currentLabel();
    },
    dispose: () => handle.dispose(),
  };
}
