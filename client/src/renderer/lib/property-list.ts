/**
 * Общий список свойств сети (задача 6ebde54e, 0.8.2; стандарт «Новая
 * программная сущность — библиотечная: сначала переиспользование, иначе
 * обоснованный общий модуль»).
 *
 * Единый переиспользуемый компонент в двух режимах:
 *
 *   * **менеджер** (`mode: 'manager'`) — диалог «Свойства» меню «Мыслесеть»:
 *     активация строки (клик/Enter) открывает редактор свойства, контекстное
 *     меню строки — «Изменить» / «Удалить» (удаление с подтверждением);
 *   * **пикер** (`mode: 'picker'`) — список «Добавить свойство…» редактора
 *     типа: активация выбирает строку (у конца связи — с её стороной) и
 *     закрывает пикер; контекстное меню — только «Изменить».
 *
 * **Строка.** Скалярное свойство — одна строка; свойство-связь — ВСЕГДА две
 * строки: имя в источнике (`side: 'source'`, стрелка `→`) и имя в назначении
 * (`side: 'target'`, стрелка `←`). Порядок — единый алфавит по отображаемому
 * имени строки, скаляры и концы связей вперемешку. Структурные «Родители» /
 * «Потомки» — системные строки: одно имя, замок, без активации и меню (как
 * было в прежнем списке).
 *
 * **Колонки.** «Имя» (перед именем — иконка типа значения у скаляров либо
 * короткая линия со стрелкой в эффективном оформлении связи), «Тип значения»
 * (у конца связи «связь (имя - имя)» с обрезкой имён по 30-й символ,
 * полное имя — в тултипе; ⓘ с описанием свойства), «Кол-во типов» (число
 * прямых привязок своей стороны, без подписей «ист./назн.»).
 *
 * **Поведение.** Кнопки-крестика удаления в строках нет. ↑/↓ двигают
 * выделение (список прокручивается), Enter и клик вызывают одну и ту же
 * функцию активации (прецедент — панель поиска, коммит 7be39cd). В пикере
 * уже подключённые имена этой стороны заблокированы и помечены, второе имя
 * той же связи остаётся доступным.
 *
 * Модуль самодостаточен: модель строк, форматирование ячеек, фильтр, поиск
 * и рендер живут здесь — параллельных списков свойств в экранах нет
 * (сторож `guard-property-list.test.ts`).
 */

import type { LinkPropertySide, LinkStyle, LinkType, NetworkProperty, PropertyValueType } from '@etn/shared';

import { button, div, el, setTooltip, span } from './dom.js';
import { svgIcon, type IconName } from './icons.js';
import { showMenuAt, type MenuItem } from './menu.js';
import { resolveLinkTypeVisual, type ResolvedLinkVisual } from './type-tree.js';
import { etn } from './etn.js';
import { store } from '../state.js';

/** Строка реестра свойств сети (`GET /networks/{nid}/properties`) со
 *  счётчиками. Свойство-связь несёт счётчики каждой стороны
 *  (`types_source_count` / `types_target_count`) — их и показывает колонка
 *  «Кол-во типов» у соответствующего конца. */
export interface PropertyRegistryRow extends NetworkProperty {
  types_count: number;
  values_count: number;
  types_source_count?: number;
  types_target_count?: number;
}

/** Человекочитаемые подписи видов значения. */
export const VALUE_TYPE_LABELS: Record<PropertyValueType, string> = {
  text: 'строка',
  number: 'число',
  date: 'дата',
  bool: 'да/нет',
  url: 'URL (сайт или файл)',
  link: 'связь',
  thought_ref: 'ссылка на мысль (legacy, недоступно)',
};

/** Предел обрезки имени стороны связи в колонке «Тип значения» (задача
 *  6ebde54e, требование 5): имя обрезается по 30-й символ включительно,
 *  полное имя показывается в тултипе. */
export const LINK_NAME_LIMIT = 30;

/**
 * Одна строка общего списка свойств. Скаляр — одна строка со стороной `null`,
 * свойство-связь — две строки (по одной на имя стороны), структурная связь —
 * одна системная строка со стороной `null` и `structural: true`.
 */
export interface PropertyListRow {
  /** Ключ строки: `<property_id>` у скаляра/структурной, `<property_id>:<side>`
   *  у конца связи. */
  id: string;
  /** Id реестровой записи — из неё строится черновик привязки/редактор. */
  propertyId: string;
  /** Имя, которое видит пользователь (у связи — имя выбранной стороны). */
  name: string;
  valueType: PropertyValueType;
  /** Сторона привязки: `source`/`target` у конца связи, `null` у скаляра. */
  side: LinkPropertySide | null;
  /** Оба имени сторон связи (для поиска и колонки «Тип значения»); у скаляра
   *  `null`. */
  linkNames: { forward: string; reverse: string } | null;
  /** Эффективное оформление линии связи (цвет/стиль/толщина с наследованием);
   *  у скаляра и структурной связи `null`. */
  visual: ResolvedLinkVisual | null;
  /** Системная «Родители»/«Потомки» — не активируется, не редактируется. */
  structural: boolean;
  /** Число прямых привязок своей стороны (`type_properties`), без подтипов. */
  typesCount: number;
  description: string | null;
  /** Исходная реестровая строка. */
  registry: PropertyRegistryRow;
}

/**
 * Строит строки списка из реестра свойств. Скаляр — одна строка; свойство-
 * связь — две строки, по одной на имя стороны (`name_forward` — источник,
 * `name_reverse` — назначение). Если тип связи каталогу ещё неизвестен,
 * строка остаётся одна — реестровое имя (копия `name_forward`), сторона
 * `source`: обратное имя назвать нечем (мягкая деградация, как в прежнем
 * списке «Добавить свойство»). Чистая — юнит-тест.
 */
export function buildPropertyListRows(
  registry: readonly PropertyRegistryRow[],
  linkTypes: readonly LinkType[],
): PropertyListRow[] {
  const out: PropertyListRow[] = [];
  for (const row of registry) {
    if (row.value_type !== 'link') {
      out.push({
        id: row.id,
        propertyId: row.id,
        name: row.name,
        valueType: row.value_type,
        side: null,
        linkNames: null,
        visual: null,
        structural: false,
        typesCount: row.types_count,
        description: row.description,
        registry: row,
      });
      continue;
    }
    if (row.config?.structural === true) {
      out.push({
        id: row.id,
        propertyId: row.id,
        name: row.name,
        valueType: 'link',
        side: null,
        linkNames: null,
        visual: null,
        structural: true,
        typesCount: row.types_count,
        description: row.description,
        registry: row,
      });
      continue;
    }
    const ltId = row.config?.link_type_id;
    const lt =
      typeof ltId === 'string' && ltId !== ''
        ? linkTypes.find((t) => t.id === ltId) ?? null
        : null;
    const linkNames = lt === null ? null : { forward: lt.name_forward, reverse: lt.name_reverse };
    const visual = lt === null ? null : resolveLinkTypeVisual(linkTypes, lt.id);
    out.push({
      id: `${row.id}:source`,
      propertyId: row.id,
      name: lt?.name_forward ?? row.name,
      valueType: 'link',
      side: 'source',
      linkNames,
      visual,
      structural: false,
      typesCount: row.types_source_count ?? 0,
      description: row.description,
      registry: row,
    });
    if (lt !== null) {
      out.push({
        id: `${row.id}:target`,
        propertyId: row.id,
        name: lt.name_reverse,
        valueType: 'link',
        side: 'target',
        linkNames,
        visual,
        structural: false,
        typesCount: row.types_target_count ?? 0,
        description: row.description,
        registry: row,
      });
    }
  }
  return out;
}

/** Заголовки колонок списка (задача 6ebde54e, требование 5). */
export function propertyListColumns(): readonly string[] {
  return ['Имя', 'Тип значения', 'Кол-во типов'];
}

/** Единый алфавитный порядок по отображаемому имени строки, вперемешку
 *  (скаляры и концы связей). Не мутирует вход. Чистая — юнит-тест. */
export function sortPropertyListRows(rows: readonly PropertyListRow[]): PropertyListRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Фильтр списка: каждое слово запроса (без учёта регистра) должно найтись в
 * отображаемом имени, в любом из имён пары связи или в описании (требование 7
 * «поиск по имени ИЛИ описанию»; имена пары — та же аннотация, что была в
 * прежнем менеджере). Пустой запрос оставляет всё. Чистая — юнит-тест.
 */
export function filterPropertyListRows(
  rows: readonly PropertyListRow[],
  query: string,
): PropertyListRow[] {
  const fragments = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s.length > 0);
  if (fragments.length === 0) return [...rows];
  return rows.filter((row) => {
    const pair = row.linkNames === null ? '' : `${row.linkNames.forward}\n${row.linkNames.reverse}`;
    const haystack = `${row.name}\n${pair}\n${row.description ?? ''}`.toLowerCase();
    return fragments.every((f) => haystack.includes(f));
  });
}

/** Почему строку нельзя активировать в пикере, или `null` — можно. Унаследованное
 *  свойство блокирует обе строки связи; подключённое — по стороне: свойство-
 *  связь, подключённое с ОДНОЙ стороны, остаётся доступным для другой (ошибка
 *  4251fbe5 — дубль имени стороны сервер отвергает, клиент не даёт выбрать его
 *  повторно). Правила 0.8.2 (коммиты c896aee, 6e17543) сохранены. Чистая —
 *  юнит-тест. */
export function rowBlockReason(
  row: Pick<PropertyListRow, 'propertyId' | 'valueType' | 'side' | 'structural'>,
  existingSides: ReadonlyMap<string, ReadonlySet<LinkPropertySide>>,
  inheritedPropertyIds: ReadonlySet<string>,
): string | null {
  if (row.structural) return null;
  if (inheritedPropertyIds.has(row.propertyId)) return 'унаследовано';
  const sides = existingSides.get(row.propertyId);
  if (sides === undefined) return null;
  if (row.valueType !== 'link') return 'подключено';
  return row.side !== null && sides.has(row.side) ? 'подключено' : null;
}

/** Обрезка имени стороны связи по 30-й символ включительно, без переноса
 *  (требование 5). Чистая — юнит-тест. */
export function truncateLinkName(name: string, limit = LINK_NAME_LIMIT): string {
  return name.length > limit ? name.slice(0, limit) : name;
}

/** Подпись колонки «Тип значения» для конца связи: «связь (имя - имя)» с
 *  обрезкой имён по 30-й символ; `full: true` — полные имена (для тултипа).
 *  У скаляра — обычная подпись вида значения. Чистая — юнит-тест. */
export function valueTypeCellLabel(row: PropertyListRow, full = false): string {
  if (row.valueType !== 'link' || row.linkNames === null) {
    return VALUE_TYPE_LABELS[row.valueType];
  }
  const cut = (name: string): string => (full ? name : truncateLinkName(name));
  return `связь (${cut(row.linkNames.forward)} - ${cut(row.linkNames.reverse)})`;
}

/** Стрелка конца связи: `→` у имени источника, `←` у имени назначения
 *  (требование 4). Чистая — юнит-тест. */
export function linkEndArrow(side: LinkPropertySide | null): string {
  return side === 'target' ? '←' : '→';
}

/** Иконка вида значения для скаляра (требование 4): переиспользует единый
 *  набор штриховых иконок клиента (`lib/icons.ts`). Для `link` иконки нет —
 *  у конца связи рисуется линия со стрелкой. Карта, а не `switch` по виду
 *  значения: диспетчер по `value_type` разрешён только общему редактору
 *  значения (`editor/value-editor.ts`, стандарт S2). Чистая — юнит-тест. */
const VALUE_TYPE_ICONS: Partial<Record<PropertyValueType, IconName>> = {
  text: 'value-text',
  number: 'value-number',
  date: 'value-date',
  bool: 'value-bool',
  url: 'value-url',
  thought_ref: 'value-ref',
};

export function valueTypeIconName(valueType: PropertyValueType): IconName | null {
  return VALUE_TYPE_ICONS[valueType] ?? null;
}

/** Описание свойства для ⓘ: непустой обрезанный текст, иначе `null` (тогда
 *  символа нет — требование 5). Чистая — юнит-тест. */
export function propertyDescriptionHint(row: PropertyListRow): string | null {
  const text = row.description?.trim();
  return text === undefined || text === '' ? null : text;
}

/** Эффективная толщина линии связи для CSS (1..6). Чистая — юнит-тест. */
export function linkEndLineWidth(visual: ResolvedLinkVisual | null): number {
  return Math.max(1, Math.min(6, visual?.width ?? 2));
}

/** Эффективный стиль линии связи для CSS. Чистая — юнит-тест. */
export function linkEndLineStyle(visual: ResolvedLinkVisual | null): LinkStyle {
  return visual?.style ?? 'solid';
}

/**
 * Догружает в каталог `store.state.linkTypes` типы связей свойств-связей,
 * которых там ещё нет (realtime-канал отстаёт, либо свойство создали только
 * что): список показывает конкретные ИМЕНА сторон, а реестр отдаёт лишь
 * `config.link_type_id`. Один загрузчик на оба потребителя списка — второго
 * не заводить.
 */
export async function ensurePropertyLinkTypes(
  networkId: string,
  rows: readonly PropertyRegistryRow[],
): Promise<void> {
  const wanted = new Set<string>();
  for (const row of rows) {
    if (row.value_type !== 'link') continue;
    const ltId = row.config?.link_type_id;
    if (typeof ltId === 'string' && ltId !== '' && !store.state.linkTypes.some((t) => t.id === ltId)) {
      wanted.add(ltId);
    }
  }
  await Promise.all(
    [...wanted].map(async (id) => {
      try {
        const lt = await etn.types.getLinkType(networkId, id);
        if (!store.state.linkTypes.some((t) => t.id === lt.id)) store.state.linkTypes.push(lt);
      } catch {
        /* имя стороны не разрешилось — строка покажет реестровое имя */
      }
    }),
  );
}

/** Режим списка: менеджер свойств или пикер строки. */
export type PropertyListMode = 'manager' | 'picker';

/** Обработчики списка — всё, что зависит от режима, живёт у потребителя. */
export interface PropertyListCallbacks {
  /** Активация строки (клик или Enter): менеджер — редактор свойства, пикер —
   *  выбор строки. Заблокированные и структурные строки не активируются. */
  onActivate: (row: PropertyListRow) => void;
  /** Контекстное меню «Изменить» — редактор свойства. */
  onEdit: (row: PropertyListRow) => void;
  /** Контекстное меню «Удалить» (только режим менеджера) — подтверждение и
   *  запрос живут у потребителя, список лишь передаёт строку. */
  onDelete?: (row: PropertyListRow) => void;
  /** Только пикер: причина, по которой строку нельзя выбрать, или `null`. */
  rowBlocked?: (row: PropertyListRow) => string | null;
  /** Только менеджер: кнопка «Добавить» в верхней строке. */
  onAdd?: () => void;
}

/** Ручка списка: потребитель владеет данными и каркасом диалога. */
export interface PropertyListHandle {
  /** Корневой узел списка (вставляется в тело диалога). */
  root: HTMLElement;
  /** Заменяет строки (после загрузки/перезагрузки реестра). */
  setRows: (rows: readonly PropertyListRow[]) => void;
  /** Текущая выделенная строка или `null`. */
  selected: () => PropertyListRow | null;
  /** Выделяет строку по id, если она есть и доступна (для подсветки свежего
   *  свойства после создания); отсутствующая строка — no-op. */
  selectRow: (id: string) => void;
  /** Ставит фокус в строку поиска (для `onMount` диалога). */
  focusSearch: () => void;
}

/**
 * Собирает список свойств. Возвращает ручку: потребитель кладёт `root` в тело
 * диалога, наполняет строками через `setRows` и читает `selected()` (например,
 * кнопкой «Выбрать» пикера).
 */
export function buildPropertyList(opts: {
  mode: PropertyListMode;
  callbacks: PropertyListCallbacks;
  searchPlaceholder?: string;
  emptyText?: string;
}): PropertyListHandle {
  const { mode, callbacks } = opts;

  const toolbar = div('form-row type-list-toolbar property-list-toolbar');
  const searchInput = el('input', 'text-input property-list-search') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = opts.searchPlaceholder ?? 'Поиск по имени или описанию…';
  // Верхняя строка: сначала поиск, затем «Добавить» (требование 7).
  toolbar.append(searchInput);
  if (mode === 'manager' && callbacks.onAdd !== undefined) {
    toolbar.append(button('Добавить', () => callbacks.onAdd?.(), 'btn small', 'Создать свойство'));
  }

  const wrap = div('admin-table-wrap property-list-wrap');
  const root = div('form-stack property-list');
  root.append(toolbar, wrap);

  let allRows: readonly PropertyListRow[] = [];
  let query = '';
  let selected: PropertyListRow | null = null;

  const blockReason = (row: PropertyListRow): string | null =>
    row.structural ? null : callbacks.rowBlocked?.(row) ?? null;

  const visibleRows = (): PropertyListRow[] =>
    filterPropertyListRows(sortPropertyListRows(allRows), query);

  const selectableRows = (rows: readonly PropertyListRow[]): PropertyListRow[] =>
    rows.filter((row) => !row.structural && blockReason(row) === null);

  /** Прокручивает список к строке и переносит класс выделения (без полного
   *  перерендера — стрелка/клик не должны мигать таблицей). */
  function applySelection(): void {
    const id = selected?.id ?? null;
    for (const tr of wrap.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
      tr.classList.toggle('selected', tr.dataset['rowId'] === id);
    }
    wrap.querySelector<HTMLTableRowElement>('tr.selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** Одна функция активации на клик и Enter (прецедент 7be39cd): менеджер —
   *  редактор, пикер — выбор строки. */
  function activate(row: PropertyListRow): void {
    if (row.structural || blockReason(row) !== null) return;
    callbacks.onActivate(row);
  }

  function openRowMenu(row: PropertyListRow, x: number, y: number): void {
    if (row.structural) return;
    const items: MenuItem[] = [{ label: 'Изменить', onClick: () => callbacks.onEdit(row) }];
    if (mode === 'manager' && callbacks.onDelete !== undefined) {
      items.push({ label: 'Удалить', danger: true, onClick: () => callbacks.onDelete?.(row) });
    }
    showMenuAt(x, y, items);
  }

  /** Знак перед именем: иконка вида значения у скаляра либо короткая линия со
   *  стрелкой в эффективном оформлении связи (требование 4). */
  function buildNameMark(row: PropertyListRow): Element | null {
    if (row.structural) return null;
    if (row.valueType === 'link') {
      const mark = span('', 'property-list-arrow');
      const line = span('', 'property-list-arrow-line');
      const width = linkEndLineWidth(row.visual);
      const style = linkEndLineStyle(row.visual);
      const color = row.visual?.color ?? null;
      line.style.borderTop = `${width}px ${style} ${color ?? 'var(--link-default, #9aa3b2)'}`;
      const arrow = span(linkEndArrow(row.side), 'property-list-arrow-head');
      if (color !== null) arrow.style.color = color;
      mark.append(line, arrow);
      return mark;
    }
    const iconName = valueTypeIconName(row.valueType);
    if (iconName === null) return null;
    const icon = svgIcon(iconName, 14);
    icon.classList.add('property-list-icon');
    return icon;
  }

  function buildRow(row: PropertyListRow): HTMLTableRowElement {
    const blocked = blockReason(row);
    const tr = el('tr', 'property-list-row');
    tr.dataset['rowId'] = row.id;
    if (row.structural || blocked !== null) tr.classList.add('row-disabled');

    const nameCell = el('td', 'property-list-name-cell');
    const mark = buildNameMark(row);
    if (mark !== null) nameCell.append(mark);
    nameCell.append(span(row.name, 'prop-name'));
    if (row.structural) {
      nameCell.append(span('  🔒 (структурное)', 'muted'));
      setTooltip(
        nameCell,
        'Системное свойство-связь для нетипизированных рёбер «Родители/Потомки». Не редактируется и не удаляется из этого диалога.',
      );
    } else if (blocked !== null) {
      nameCell.append(span(`  ${blocked}`, 'muted'));
      setTooltip(
        nameCell,
        blocked === 'унаследовано'
          ? 'Свойство уже наследуется этим типом от предка'
          : row.valueType === 'link'
            ? 'Это имя стороны свойства-связи уже подключено — можно подключить другое имя (обратное).'
            : 'Свойство уже подключено к этому типу',
      );
    }

    const typeCell = el('td', 'property-list-type-cell muted');
    const label = valueTypeCellLabel(row);
    typeCell.append(span(label, 'property-list-type-label'));
    if (label !== valueTypeCellLabel(row, true)) {
      setTooltip(typeCell, valueTypeCellLabel(row, true));
    }
    const hint = propertyDescriptionHint(row);
    if (hint !== null) {
      const info = span('ⓘ', 'muted prop-hint');
      setTooltip(info, hint);
      typeCell.append(info);
    }

    const countCell = el('td', 'property-list-count-cell muted', String(row.typesCount));

    tr.append(nameCell, typeCell, countCell);
    if (!row.structural) {
      // Заблокированную строку выбирать нельзя (старое поведение пикера):
      // клик по ней ничего не делает, только контекстное меню.
      if (blocked === null) {
        tr.addEventListener('click', (event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
          selected = row;
          applySelection();
          activate(row);
        });
      }
      tr.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openRowMenu(row, event.clientX, event.clientY);
      });
    }
    return tr;
  }

  function rerender(): void {
    const rows = visibleRows();
    const searching = query.trim() !== '';
    if (rows.length === 0) {
      wrap.replaceChildren(
        el('p', 'muted', searching ? 'Ничего не найдено.' : opts.emptyText ?? 'Нет свойств.'),
      );
      return;
    }
    const table = el('table', 'table-list property-list-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of propertyListColumns()) headRow.append(el('th', undefined, label));
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const row of rows) tbody.append(buildRow(row));
    table.append(tbody);
    wrap.replaceChildren(table);
    applySelection();
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    rerender();
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = selectableRows(visibleRows());
      if (rows.length === 0) return;
      event.preventDefault();
      const at = rows.findIndex((r) => r.id === selected?.id);
      selected =
        event.key === 'ArrowDown'
          ? rows[Math.min(rows.length - 1, at + 1)] ?? rows[0]!
          : rows[Math.max(0, at - 1)] ?? rows[0]!;
      applySelection();
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (selected === null) return;
      event.preventDefault();
      activate(selected);
    }
  });

  return {
    root,
    setRows: (rows: readonly PropertyListRow[]) => {
      allRows = rows;
      if (selected !== null && !rows.some((r) => r.id === selected?.id)) selected = null;
      rerender();
    },
    selected: () => selected,
    selectRow: (id: string) => {
      const row = allRows.find((r) => r.id === id) ?? null;
      if (row === null || row.structural || blockReason(row) !== null) return;
      selected = row;
      applySelection();
    },
    focusSearch: () => searchInput.focus(),
  };
}
