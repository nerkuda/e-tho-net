/**
 * Поле выбора свойства-связи с живым поиском — переиспользуемый компонент
 * (ошибка dc175a5b, версия 0.8.3; поле введено коммитом 0d9485d по ошибке
 * 1dd08949; паттерн «поле + кнопка → диалог» унифицирован с полем типа мысли
 * по ошибке 5817b009).
 *
 * **Зачем отдельный модуль.** Поле понадобится не только диалогу добавления
 * мысли с карты: пользователь выбирает СВОЙСТВО-связь (имя его стороны), а не
 * тип связи, в разных местах. Поэтому модель вариантов и поле живут здесь, а
 * потребитель передаёт только строки общего списка свойств
 * (`lib/property-list.ts` — единственный владелец реестровых строк, значков
 * концов связи и их поиска).
 *
 * **Паттерн поля — как у поля типа мысли** (`buildEntityCombo`,
 * `lib/entity-picker.ts`, ошибка 5817b009): живой поиск в поле (общая
 * выпадашка `wireSuggest`) плюс компактная кнопка «…», открывающая отдельный
 * диалог выбора с полным списком и поиском внутри. Знаешь название — ищешь
 * горячо; не знаешь — смотришь список. Одинаковый UX для подобного — так просил
 * пользователь; третьего варианта нет.
 *
 * **Что видно в списке.** Пункт «без свойства» (бестиповая связь в направлении
 * диалога) и по одному пункту на КАЖДОЕ имя стороны свойства-связи: значок
 * конца связи (направление + эффективное оформление линии, `buildLinkEndIcon`
 * общего списка), имя стороны и серая пара связи в скобках
 * `(прямое -> обратное)`. Прежние подписи «источник/назначение · связь …»
 * убраны — занимали место без пользы (ошибка 5817b009).
 *
 * **Живой поиск** идёт тем же фильтром, что у общего списка свойств: совпадение
 * по имени стороны, по любому из имён пары типа связи или по описанию
 * (`filterPropertyListRows`).
 *
 * **Значение.** Выбранное имя стороны — `key` записи (`properties.set`):
 * сервер по имени сам выводит свойство и направление ребра.
 */

import type { LinkPropertySide } from '@etn/shared';
import { t } from './i18n.js';

import { showDialog } from './dialog.js';
import { button, div, el, span } from './dom.js';
import {
  buildLinkEndIcon,
  filterPropertyListRows,
  linkEndIconSpec,
  sortPropertyListRows,
  type LinkEndIconSpec,
  type PropertyListRow,
} from './property-list.js';
import { wireSuggest, type SuggestEntry, type SuggestHandle, type SuggestSource } from './suggest-dropdown.js';
import { fieldInput } from './ui/field.js';

/** Подпись пункта «свойство не выбрано» (бестиповая связь в направлении диалога). */
export const LINK_PROPERTY_NONE_LABEL = 'без свойства';

/** Заголовок диалога выбора свойства-связи (кнопка «…»). */
export const LINK_PROPERTY_PICKER_TITLE = 'Выбрать свойство связи';

/**
 * Минимальная ширина выпадашки, px (ошибка 5817b009): поле ввода в диалоге
 * добавления узкое (~280px на две колонки), и имена сторон с парами связи в
 * списке не помещались. Список позиционируется абсолютно (слой в `document.body`),
 * поэтому может быть заметно шире поля. Потолок выпадашки поднят тем же
 * значением — иначе `positionBodyDropdown` обрезал бы ширину до прежних 320px.
 * 560px — по фидбэку приёмки (ошибка 5c7f8376): прежние 640 были избыточны;
 * той же ширины просили выпадашку типа мысли в том же диалоге (передаётся как
 * `dropdownMinWidth` встроенного комбо, `lib/entity-picker.ts`).
 */
export const LINK_PROPERTY_DROPDOWN_MIN_WIDTH = 560;

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
  /** Пара имён типа связи в скобках: «(прямое -> обратное)»; `null` — тип связи
   *  каталогу неизвестен, обратное имя назвать нечем. */
  pairLabel: string | null;
  /** Значок конца связи: направление (вниз — исходящая сторона, вверх —
   *  входящая, задача 88def930) и оформление линии. */
  linkEnd: LinkEndIconSpec;
}

/** Вариант поля из строки общего списка: только сторона свойства-связи
 *  (скаляры и структурные «Родители»/«Потомки» в поле не выбираются). */
function optionOf(row: PropertyListRow): LinkPropertyOption | null {
  if (row.valueType !== 'link' || row.structural || row.side === null) return null;
  const names = row.linkNames;
  return {
    value: row.id,
    row,
    label: row.name,
    side: row.side,
    pairLabel: names === null ? null : `(${names.forward} -> ${names.reverse})`,
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

/** Строка выпадашки по варианту: значок конца связи, имя стороны и пара. */
function optionEntry(option: LinkPropertyOption): SuggestEntry {
  const entry: SuggestEntry = {
    value: option.value,
    label: option.label,
    linkEnd: option.linkEnd,
  };
  if (option.pairLabel !== null) entry.note = option.pairLabel;
  return entry;
}

/**
 * Строка списка диалога выбора по варианту. Класс `link-property-option`
 * (не `type-combo-item`): строку каталога типов собирает единственный общий
 * модуль выпадашки (сторож `guard-entity-picker`), а это список свойства-связи
 * со своей разметкой — значок конца связи рисует общий список свойств
 * (`buildLinkEndIcon`), подписи те же, что в выпадашке живого поиска.
 */
function optionRow(option: LinkPropertyOption, onPick: () => void): HTMLElement {
  const row = div('link-property-option');
  row.append(buildLinkEndIcon(option.linkEnd));
  const label = span(option.label, 'link-property-option-label');
  label.title = option.label;
  row.append(label);
  if (option.pairLabel !== null) row.append(span(option.pairLabel, 'link-property-option-note'));
  row.addEventListener('click', onPick);
  return row;
}

/** Пункт «без свойства» в списке диалога (снимает выбор). */
function noneRow(onPick: () => void): HTMLElement {
  const row = div('link-property-option link-property-option-none');
  row.append(span(LINK_PROPERTY_NONE_LABEL, 'link-property-option-label'));
  row.addEventListener('click', onPick);
  return row;
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
  /** Корневой узел поля (поле ввода с живым поиском и кнопкой «…»). */
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
 * Собирает поле выбора свойства-связи тем же паттерном, что поле типа мысли
 * (`buildEntityCombo`, ошибка 5817b009): обычное поле ввода с живым поиском
 * (общая выпадашка `wireSuggest`) и компактная кнопка «…», открывающая диалог
 * выбора с полным списком и поиском внутри. Выбранное имя стороны показано в
 * поле текстом; повторный фокус очищает поле и снова показывает весь список
 * (потеря фокуса без выбора возвращает подпись).
 */
export function buildLinkPropertyField(opts: LinkPropertyFieldOptions): LinkPropertyField {
  let rows: readonly PropertyListRow[] = opts.rows;
  let pick: LinkPropertyPick | null = opts.value ?? null;

  const root = div('link-property-field');
  // Поле — единая рамка, как у поля значения свойства-связи: кнопка «…» лежит
  // в правом углу, строка ввода занимает остальное.
  const box = div('st-f-chipfield link-property-field-box');
  const input = fieldInput({ extraClass: 'link-property-input' }) as HTMLInputElement;
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder ?? t('actions.search');

  /** Подпись текущего выбранного значения (нет — пусто). */
  const currentLabel = (): string => {
    const chosen = pick;
    if (chosen === null) return '';
    const option = linkPropertyOptions(rows).find((o) => o.value === valueOf(chosen));
    return option?.label ?? chosen.key;
  };

  /** Принимает выбранный вариант (или `null` — «без свойства»): пишет значение,
   *  подпись в поле и уведомляет потребителя. */
  const choose = (option: LinkPropertyOption | null): void => {
    pick =
      option === null
        ? null
        : { propertyId: option.row.propertyId, side: option.side, key: option.label };
    input.value = option?.label ?? '';
    opts.onChange(pick);
  };

  // Кнопка «…» — диалог выбора свойства-связи с полным списком (как у поля
  // типа мысли). Создаётся до выпадашки, чтобы диалог мог отдать выбор в
  // общий choose.
  const pickBtn = button('…', () => openPicker(), 'entity-combo-pick link-property-pick', LINK_PROPERTY_PICKER_TITLE);
  pickBtn.type = 'button';

  box.append(input, pickBtn);
  root.append(box);

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
    minWidth: LINK_PROPERTY_DROPDOWN_MIN_WIDTH,
    onPick: (entry) => {
      const option = linkPropertyOptions(rows).find((o) => o.value === entry.value) ?? null;
      choose(option);
    },
  });

  /**
   * Диалог выбора свойства-связи (кнопка «…») — полный список с поиском
   * внутри, по образцу диалога выбора типа мысли. Клик по строке сразу
   * выбирает и закрывает диалог; «Отмена», Esc и × — закрытие без выбора.
   */
  function openPicker(): void {
    const search = fieldInput({ extraClass: 'link-property-search' }) as HTMLInputElement;
    search.type = 'text';
    search.autocomplete = 'off';
    search.placeholder = t('actions.search');
    const list = div('link-property-picker-list');
    const body = div('link-property-picker');
    body.append(search, list);

    let closeSelf: (() => void) | null = null;
    const render = (): void => {
      list.replaceChildren();
      const query = search.value;
      const needle = query.trim().toLowerCase();
      const showNone = needle === '' || LINK_PROPERTY_NONE_LABEL.includes(needle);
      if (showNone) {
        list.append(
          noneRow(() => {
            closeSelf?.();
            choose(null);
          }),
        );
      }
      const options = filterLinkPropertyOptions(linkPropertyOptions(rows), query);
      for (const option of options) {
        list.append(
          optionRow(option, () => {
            closeSelf?.();
            choose(option);
          }),
        );
      }
      if (!showNone && options.length === 0) {
        list.append(el('p', 'muted link-property-empty', 'Ничего не найдено.'));
      }
    };
    search.addEventListener('input', render);

    closeSelf = showDialog({
      title: LINK_PROPERTY_PICKER_TITLE,
      body,
      size: 'm',
      buttons: [{ label: t('actions.cancel') }],
      onMount: () => {
        render();
        search.focus();
      },
    });
  }

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
