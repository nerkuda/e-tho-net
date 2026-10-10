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
 * строки: имя в источнике (`side: 'source'`, исходящая — стрелка вниз) и имя в
 * назначении (`side: 'target'`, входящая — стрелка вверх, задача 88def930).
 * Порядок — единый алфавит по
 * отображаемому имени строки, скаляры и концы связей вперемешку. Структурные
 * «Родители» / «Потомки» — системные строки: одно имя, замок, без активации и
 * меню (как было в прежнем списке).
 *
 * **Колонки.** «Имя» (перед именем — иконка типа значения у скаляров либо
 * единый значок «вертикальная линия со стрелкой на конце» в эффективном
 * оформлении связи), «Тип значения»
 * (у конца связи «связь (имя - имя)» с обрезкой имён по 30-й символ,
 * полное имя — в тултипе; ⓘ с описанием свойства), «Кол-во типов» (число
 * прямых привязок своей стороны, без подписей «ист./назн.»).
 *
 * **Поведение.** Рендер — единый табличный фасад `lib/ui/table.ts` (задача
 * ada14160, требование 93115633): текущая строка, клавиатура (↑/↓, Home/End,
 * PgUp/PgDn, Enter), контекстное меню строки, сортировка по колонкам,
 * копирование Ctrl+C. Кнопки-крестика удаления в строках нет. Активация
 * строки — Enter или двойной клик (одна функция `activate`); одиночный клик
 * ставит текущую строку (правило 6 требования 11ddd910: список — не выбор).
 * В режиме менеджера над списком стоят строка поиска (правило 1) и строка
 * управления (правило 2): «Добавить», «Изменить», «Удалить», «Копировать» —
 * последние три действуют на текущую строку и погасают без неё. В пикере уже
 * подключённые имена этой стороны заблокированы и помечены, второе имя той же
 * связи остаётся доступным.
 *
 * Модуль самодостаточен: модель строк, форматирование ячеек, фильтр и поиск
 * живут здесь — параллельных списков свойств в экранах нет (сторож
 * `guard-property-list.test.ts`).
 */

import type { LinkPropertySide, LinkStyle, LinkType, NetworkProperty, PropertyValueType } from '@etn/shared';
import { t } from './i18n.js';

import { div, setTooltip, span } from './dom.js';
import { svgIcon, type IconName } from './ui/icon.js';
import { menuAction, type MenuItem } from './menu.js';
import { resolveLinkTypeVisual, type ResolvedLinkVisual } from './type-tree.js';
import { etn } from './etn.js';
import { store } from '../state.js';
import { uiButton } from './ui/button.js';
import { fieldInput } from './ui/field.js';
import { createTable } from './ui/table.js';

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
  // Кросс-сетевая ссылка (задача 7849008a, ADR ae8346d0): адрес
  // `n:<network_id>#<thought_id>` другой сети; снапшот имени хранится
  // служебно, чтение чужой базы не открывает.
  cross_network_ref: 'кросс-сетевая ссылка',
  // Ссылка на публикацию (0.11.1, задача f37b468d): значение — публикация
  // текущей сети.
  publication: 'публикация',
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

/** Заголовки колонок списка (задача 6ebde54e, требование 5; строки — из
 *  словаря локализации, задача ada14160). */
export function propertyListColumns(): readonly string[] {
  return [
    t('propertyList.col.name'),
    t('propertyList.col.valueType'),
    t('propertyList.col.typesCount'),
  ];
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

/**
 * Спецификация единого значка конца связи (требование 4): направление стрелки
 * плюс эффективное оформление линии. Чистая — юнит-тест.
 */
export interface LinkEndIconSpec {
  /** Направление стрелки значка: `down` — исходящая связь (владелец — источник,
   *  «потомки»-подобная), `up` — входящая (владелец — цель,
   *  «родители»-подобная). Совпадает с расположением предков (сверху) и
   *  потомков (снизу) на карте и в структурах (задача 88def930). */
  direction: LinkEndDirection;
  /** Толщина линии в px (1..6) из эффективных настроек связи. */
  width: number;
  style: LinkStyle;
  /** Цвет линии и стрелки; `null` — `--link-default` из CSS. */
  color: string | null;
}

/** Направление стрелки значка. */
export type LinkEndDirection = 'down' | 'up';

/** Направление стрелки значка: `down` у стороны-источника (исходящая связь),
 *  `up` у стороны-цели (входящая); бестиповый конец ведёт себя как исходящий.
 *  Чистая — юнит-тест. */
export function linkEndDirection(side: LinkPropertySide | null): LinkEndDirection {
  return side === 'target' ? 'up' : 'down';
}

/** Собирает спецификацию значка из стороны строки и эффективного оформления
 *  связи. Чистая — юнит-тест. */
export function linkEndIconSpec(
  side: LinkPropertySide | null,
  visual: ResolvedLinkVisual | null,
): LinkEndIconSpec {
  return {
    direction: linkEndDirection(side),
    width: linkEndLineWidth(visual),
    style: linkEndLineStyle(visual),
    color: visual?.color ?? null,
  };
}

/**
 * Геометрия единого значка в CSS-пикселях: `viewBox` совпадает с размером
 * элемента, поэтому толщина линии задаётся настройками связи напрямую (1..6px).
 * Линия вертикальная, стрелка-шеврон приделана вершиной к её концу — один
 * цельный указатель направления вместо линии и глифа рядом. Направление —
 * координатами (вниз/вверх), а не зеркалированием: предки на карте сверху,
 * потомки снизу (задача 88def930).
 */
const LINK_END_ICON = { size: 18, mid: 9, start: 3, end: 14, wing: 5 } as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Штрих прерывистой линии значка (`null` — сплошная): `dashed` — штрихи,
 *  `dotted` — точки; длины в пикселях значка. Чистая — юнит-тест. */
export function linkEndDashArray(style: LinkStyle): string | null {
  if (style === 'dashed') return '5 3';
  if (style === 'dotted') return '1 3';
  return null;
}

function svgNode(name: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** Единый значок конца связи: `svg` с вертикальной линией и приделанной к её
 *  концу стрелкой (требование 4; задача 88def930). Оформление линии — из
 *  эффективных настроек связи; направление задаётся координатами: исходящая
 *  (источник) — сверху вниз, входящая (цель) — снизу вверх.
 *
 *  Экспортирован для переиспользования другими списками выбора свойства-связи
 *  (общий комбо-пикер, четвёртый источник «свойство связи», `lib/entity-picker.ts`;
 *  требование cdb6b52f): значок рисует ТОЛЬКО общий список свойств — второй
 *  отрисовки линии со стрелкой нет. */
export function buildLinkEndIcon(spec: LinkEndIconSpec): SVGSVGElement {
  const { size, mid, start, end, wing } = LINK_END_ICON;
  const down = spec.direction === 'down';
  // Линия: у исходящей рисуется сверху вниз, у входящей — снизу вверх; вершина
  // шеврона — на конце линии (`y2`), крылья — на `wing` позади неё.
  const y1 = down ? start : end;
  const y2 = down ? end : start;
  const wingY = down ? y2 - wing : y2 + wing;
  const svg = svgNode('svg', {
    class: 'property-list-link-icon',
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': spec.width,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'data-direction': spec.direction,
    'aria-hidden': 'true',
  }) as SVGSVGElement;
  const line = svgNode('line', { x1: mid, y1, x2: mid, y2 });
  const dash = linkEndDashArray(spec.style);
  if (dash !== null) line.setAttribute('stroke-dasharray', dash);
  const head = svgNode('polyline', {
    points: `${mid - wing},${wingY} ${mid},${y2} ${mid + wing},${wingY}`,
  });
  svg.append(line, head);
  if (spec.color !== null) svg.style.color = spec.color;
  return svg;
}

/** Иконка вида значения для скаляра (требование 4): переиспользует единый
 *  набор штриховых иконок клиента (`lib/ui/icon.ts`). Для `link` иконки нет —
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
  // Кросс-сетевая ссылка (задача 7849008a).
  cross_network_ref: 'value-cross-network-ref',
  // `publication` (0.11.1, задача 3275fd8d) — ссылка на публикацию сети:
  // иконка-книга. Полный рендер поля — общий редактор значения.
  publication: 'value-publication',
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
  /** Активация строки (Enter или двойной клик): менеджер — редактор свойства,
   *  пикер — выбор строки. Заблокированные и структурные строки не активируются. */
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
  /** Ставит клавиатурный фокус на таблицу (клавиатура — от фасада). */
  focus: () => void;
  /** Копирует текущую строку в буфер обмена (кнопка «Копировать», правило 2
   *  требования 11ddd910). */
  copyCurrent: () => void;
}

/**
 * Собирает список свойств. Возвращает ручку: потребитель кладёт `root` в тело
 * диалога, наполняет строками через `setRows` и читает `selected()` (например,
 * кнопкой «Выбрать» пикера).
 *
 * Источник строк — массив: реестр свойств сети (`GET /networks/{nid}/
 * properties`) в store не лежит, его загружает и перезагружает потребитель.
 * Реактивная подписка на селектор появится, когда источник переедет в store
 * (требование 628d33ee) — до тех пор перерисовку заказывает `setRows`, а
 * realtime-хук держит потребитель.
 */
export function buildPropertyList(opts: {
  mode: PropertyListMode;
  callbacks: PropertyListCallbacks;
  searchPlaceholder?: string;
  emptyText?: string;
  emptyHint?: string;
}): PropertyListHandle {
  const { mode, callbacks } = opts;

  // Правило 1 требования 11ddd910: поле горячего поиска — ПЕРВАЯ строка,
  // плейсхолдер из словаря.
  const searchRow = div('form-row type-list-search');
  const searchInput = fieldInput({ extraClass: 'property-list-search' }) as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = opts.searchPlaceholder ?? t('actions.search');
  searchRow.append(searchInput);

  // Правило 2: строка управления НАД списком (под поиском) — только режиму
  // менеджера. «Изменить»/«Удалить» действуют на ТЕКУЩУЮ строку и погасают
  // без неё (и для системной структурной строки, см. `updateButtons`).
  const toolbar = div('form-row type-list-toolbar property-list-toolbar');
  let editBtn: HTMLButtonElement | null = null;
  let deleteBtn: HTMLButtonElement | null = null;
  let copyBtn: HTMLButtonElement | null = null;
  if (mode === 'manager') {
    toolbar.append(
      uiButton({
        label: t('propertyList.add'),
        role: 'secondary',
        size: 's',
        title: t('propertyList.addHint'),
        onClick: () => callbacks.onAdd?.(),
      }),
      (editBtn = uiButton({
        label: t('listActions.edit'),
        role: 'secondary',
        size: 's',
        title: t('listActions.editHint'),
        disabled: true,
        onClick: () => {
          const row = selected();
          if (row !== null && !row.structural) callbacks.onEdit(row);
        },
      })),
      (deleteBtn = uiButton({
        label: t('actions.delete'),
        role: 'secondary',
        size: 's',
        title: t('listActions.deleteHint'),
        disabled: true,
        onClick: () => {
          const row = selected();
          if (row !== null && !row.structural) callbacks.onDelete?.(row);
        },
      })),
      (copyBtn = uiButton({
        label: t('listActions.copy'),
        role: 'secondary',
        size: 's',
        title: t('listActions.copyHint'),
        disabled: true,
        onClick: () => copyCurrent(),
      })),
    );
  }

  const wrap = div('admin-table-wrap property-list-wrap');
  // Высоту обёртки задаёт раскладка диалога-списка (`.list-dialog-body`,
  // правило 9 требования 11ddd910): область списка тянется на свободную
  // высоту и не схлопывается при пустом поиске (ошибка f68bb43c).
  const root = div('form-stack property-list list-dialog-body');
  root.append(searchRow, ...(mode === 'manager' ? [toolbar] : []), wrap);

  let allRows: readonly PropertyListRow[] = [];
  let query = '';
  let selectedId: string | null = null;

  const blockReason = (row: PropertyListRow): string | null =>
    row.structural ? null : callbacks.rowBlocked?.(row) ?? null;

  const visibleRows = (): PropertyListRow[] =>
    filterPropertyListRows(sortPropertyListRows(allRows), query);

  /** Текущая строка списка (правило 5 требования 11ddd910). */
  function selected(): PropertyListRow | null {
    return selectedId === null ? null : allRows.find((r) => r.id === selectedId) ?? null;
  }

  /** Копирует текущую строку в буфер обмена (TSV фасада `lib/ui/table`). */
  function copyCurrent(): void {
    const text = table.buildCopyText();
    if (text.trim() === '') return;
    void navigator.clipboard?.writeText(text);
  }

  /** Гасит кнопки текущей строки, когда строки нет или она системная. */
  function updateButtons(): void {
    const row = selected();
    const actionable = row !== null && !row.structural;
    if (editBtn !== null) editBtn.disabled = !actionable;
    if (deleteBtn !== null) deleteBtn.disabled = !actionable;
    if (copyBtn !== null) copyBtn.disabled = row === null;
  }

  /** Одна функция активации на Enter и двойной клик: менеджер — редактор
   *  свойства, пикер — выбор строки. Заблокированные и структурные строки не
   *  активируются. */
  function activate(row: PropertyListRow): void {
    if (row.structural || blockReason(row) !== null) return;
    callbacks.onActivate(row);
  }

  /** Контекстное меню строки из общего словаря пунктов (`lib/menu.ts`):
   *  «Изменить» и «Копировать» всем неструктурным, «Удалить» — только
   *  менеджеру (правило 8 требования 11ddd910). */
  function rowMenu(row: PropertyListRow): MenuItem[] {
    if (row.structural) return [];
    const items: MenuItem[] = [
      menuAction(t('propertyList.menu.edit'), () => callbacks.onEdit(row)),
      menuAction(t('listActions.copy'), () => {
        table.setCurrent(row.id);
        copyCurrent();
      }),
    ];
    if (mode === 'manager' && callbacks.onDelete !== undefined) {
      items.push(
        menuAction(t('actions.delete'), () => callbacks.onDelete?.(row), { danger: true }),
      );
    }
    return items;
  }

  /** Знак перед именем: иконка вида значения у скаляра либо единый значок
   *  «короткая линия со стрелкой на конце» в эффективном оформлении связи
   *  (требование 4). */
  function buildNameMark(row: PropertyListRow): Element | null {
    if (row.structural) return null;
    if (row.valueType === 'link') {
      return buildLinkEndIcon(linkEndIconSpec(row.side, row.visual));
    }
    const iconName = valueTypeIconName(row.valueType);
    if (iconName === null) return null;
    const icon = svgIcon(iconName, 14);
    icon.classList.add('property-list-icon');
    return icon;
  }

  /** Ячейка «Имя»: знак + имя, у структурных/заблокированных — пометка и
   *  подсказка. */
  function buildNameCell(row: PropertyListRow): Node {
    const cell = div('property-list-name-cell');
    const mark = buildNameMark(row);
    if (mark !== null) cell.append(mark);
    cell.append(span(row.name, 'prop-name'));
    const blocked = blockReason(row);
    if (row.structural) {
      cell.append(span(`  ${t('propertyList.structuralMark')}`, 'muted'));
      setTooltip(cell, t('propertyList.structuralHint'));
    } else if (blocked !== null) {
      cell.append(span(`  ${blocked}`, 'muted'));
      setTooltip(
        cell,
        blocked === 'унаследовано'
          ? 'Свойство уже наследуется этим типом от предка'
          : row.valueType === 'link'
            ? 'Это имя стороны свойства-связи уже подключено — можно подключить другое имя (обратное).'
            : 'Свойство уже подключено к этому типу',
      );
    }
    return cell;
  }

  /** Ячейка «Тип значения»: подпись (у связи — имена сторон с обрезкой),
   *  полное имя пары — тултипом, ⓘ с описанием свойства. */
  function buildTypeCell(row: PropertyListRow): Node {
    const cell = div('property-list-type-cell muted');
    const label = valueTypeCellLabel(row);
    cell.append(span(label, 'property-list-type-label'));
    if (label !== valueTypeCellLabel(row, true)) {
      setTooltip(cell, valueTypeCellLabel(row, true));
    }
    const hint = propertyDescriptionHint(row);
    if (hint !== null) {
      const info = span('ⓘ', 'muted prop-hint');
      setTooltip(info, hint);
      cell.append(info);
    }
    return cell;
  }

  const columns = propertyListColumns();

  const table = createTable<PropertyListRow>({
    ariaLabel: t('propertyList.aria'),
    columns: [
      {
        key: 'name',
        header: columns[0] ?? '',
        width: '45%',
        sortable: true,
        sortValue: (row) => row.name,
        text: (row) => row.name,
        render: (row) => buildNameCell(row),
      },
      {
        key: 'valueType',
        header: columns[1] ?? '',
        width: '40%',
        sortable: true,
        sortValue: (row) => valueTypeCellLabel(row),
        text: (row) => valueTypeCellLabel(row),
        render: (row) => buildTypeCell(row),
      },
      {
        key: 'typesCount',
        header: columns[2] ?? '',
        width: '15%',
        align: 'end',
        sortable: true,
        sortValue: (row) => row.typesCount,
        text: (row) => String(row.typesCount),
        render: (row) => span(String(row.typesCount), 'property-list-count-cell muted'),
      },
    ],
    rows: [],
    rowKey: (row) => row.id,
    emptyText: opts.emptyText ?? t('propertyList.empty'),
    emptyHint: opts.emptyHint ?? t('propertyList.emptyHint'),
    onActivate: (row) => activate(row),
    onCurrentChange: (key) => {
      selectedId = key;
      updateButtons();
    },
    rowMenu: (row) => rowMenu(row),
  });
  wrap.append(table.element);

  /** Пустое состояние зависит от поиска: без совпадений — «Ничего не
   *  найдено» с подсказкой изменить запрос, иначе текст потребителя с
   *  подсказкой «что добавить». Состояние рисует общий компонент
   *  `lib/ui/empty-state.ts` через `table.setEmpty`. */
  function syncEmptyText(): void {
    table.setEmpty(
      query.trim() !== ''
        ? {
            title: t('propertyList.emptySearch'),
            hint: t('propertyList.emptySearchHint'),
          }
        : {
            title: opts.emptyText ?? t('propertyList.empty'),
            hint: opts.emptyHint ?? t('propertyList.emptyHint'),
          },
    );
  }

  /** Перерисовывает строки по текущему фильтру/сортировке. */
  function refresh(): void {
    syncEmptyText();
    table.setRows(visibleRows());
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    refresh();
  });

  return {
    root,
    setRows: (rows: readonly PropertyListRow[]) => {
      allRows = rows;
      if (selectedId !== null && !rows.some((r) => r.id === selectedId)) {
        selectedId = null;
        table.setCurrent(null);
      }
      refresh();
      updateButtons();
    },
    selected,
    selectRow: (id: string) => {
      const row = allRows.find((r) => r.id === id) ?? null;
      if (row === null || row.structural || blockReason(row) !== null) return;
      selectedId = id;
      table.setCurrent(id);
      updateButtons();
    },
    focus: () => table.focus(),
    copyCurrent,
  };
}
