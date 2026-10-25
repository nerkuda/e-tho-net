/**
 * Чистая логика диалога «Изменить значение свойства…» панели выделения
 * (0.14.1, задача 6ebcd8d6; спека панели 2fc9d85c, сценарий a6b54f0f).
 *
 * Модуль без DOM и без обращений к сети: по снимку «выделенные мысли × их
 * значения свойств» строит строки таблицы, считает общее значение и план
 * применения. Диалог (`selection/dialogs.ts`) остаётся тонким — вся
 * арифметика, которую надо проверять юнит-тестами без диалога, живёт здесь.
 *
 * **Строка = (свойство, сторона).** Свойство-связь представлена сторонами
 * (`source`/`target`) — как в карточке и пикере: `зависит от` и
 * `используется в` — две независимые строки. Структурные «Родители»/
 * «Потомки» и рёбра без реестрового свойства (`property_id === ''`) в таблицу
 * не входят: записать их значением нельзя, а их «очистка» — операция над
 * деревом, а не над свойством.
 *
 * **Общее значение.** Наличные значения (у кого свойство есть) одинаковы —
 * значение показывается в поле. Отсутствие у части мыслей «разным» не
 * считается: оно видно счётчиком «есть у K из N». Для связи одинаковость —
 * равенство МНОЖЕСТВ целей, для множественных text/url — множеств без учёта
 * порядка.
 *
 * **План применения.** Галочка + значение — запись ВСЕМ обработанным мыслям
 * (в том числе без свойства: значение станет внетиповым). Галочка + пусто —
 * удаление только там, где значение было. Снятая галочка — не трогается.
 */

import type {
  LinkPropertySide,
  LinkPropertyValueItem,
  LinkPropertyValues,
  LinkType,
  NetworkProperty,
  PropertyConfig,
  PropertyValue,
  PropertyValueType,
} from '@etn/shared';
import { formatCrossNetworkAddress } from '@etn/shared';
import {
  registryAllowedOppositeTypeIds,
  type RegistryLinkBindingTypeIds,
} from '../lib/link-binding-types.js';

/** Реестровое свойство в объёме, нужном построению строк (срез
 *  `NetworkProperty` + производные типы привязок по сторонам). */
export type BulkRegistryProperty = Pick<
  NetworkProperty,
  'id' | 'name' | 'value_type' | 'config' | 'description'
> &
  RegistryLinkBindingTypeIds;

/** Мысль выделения: id и подпись (для причин отказа и подсказок). */
export interface BulkThought {
  id: string;
  title: string;
}

/** Имена сторон типа связи — срез каталога `LinkType`. */
export type BulkLinkType = Pick<LinkType, 'id' | 'name_forward' | 'name_reverse'>;

/** Definition-срез, который принимает `buildValueEditor` (без привязки к типу). */
export interface BulkValueDefinition {
  value_type: PropertyValueType;
  config: PropertyConfig | null;
  required: boolean;
  default_value: null;
  side: LinkPropertySide | null;
  key: string;
  property_id: string;
  /** Допустимые типы противоположной стороны — из привязок реестра
   *  (`binding_*_type_ids`, ошибка f8f8fa49). */
  allowed_opposite_type_ids?: string[];
}

/** Одна строка таблицы — (свойство, сторона). */
export interface BulkPropertyRow {
  /** Ключ строки: `<property_id>` у скаляра, `<property_id>:<side>` у связи —
   *  тот же формат, что у `PropertyListRow.id` общего списка свойств. */
  key: string;
  propertyId: string;
  side: LinkPropertySide | null;
  /** Отображаемое имя (у связи — имя выбранной стороны). */
  name: string;
  /** Имя реестрового свойства — первичный ключ сортировки (стороны подряд). */
  sortName: string;
  valueType: PropertyValueType;
  config: PropertyConfig | null;
  /** «Есть у K из N». */
  presentCount: number;
  totalCount: number;
  /** Мысли, у которых строка есть, — адресаты очистки. */
  presentIds: readonly string[];
  /** `true` — наличные значения одинаковы (`value` заполнено). */
  uniform: boolean;
  /** Значение для редактора: скаляр — хранимая форма, связь — `string[]`
   *  идентификаторов целей; `null` — пусто/«разные значения». */
  value: unknown | null;
  /** Подписи целей связи, собранные из чтения (чипы редактора). */
  linkTitles: ReadonlyMap<string, string>;
  /** Определение для общего редактора значения. */
  definition: BulkValueDefinition;
}

/** Отметка строки в форме диалога. */
export interface BulkRowSelection {
  key: string;
  checked: boolean;
  value: unknown | null;
}

/** Одна операция применения — пара (мысль, строка). */
export interface BulkApplyOperation {
  rowKey: string;
  thoughtId: string;
  kind: 'set' | 'remove';
  /** Имя реестрового свойства — ключ записи (`properties.set/remove`). */
  propertyKey: string;
  propertyId: string;
  side: LinkPropertySide | null;
  /** Значение записи (`kind: 'set'`): скаляр как есть, связь — `string[]`. */
  value?: unknown;
}

/** Тип формы чтения значений: скаляр или проекция рёбер. */
type PropertyValueEntry = PropertyValue | LinkPropertyValues;

/** Ключ строки: `<property_id>` у скаляра, `<property_id>:<side>` у связи. */
export function bulkRowKey(propertyId: string, side: LinkPropertySide | null): string {
  return side === null ? propertyId : `${propertyId}:${side}`;
}

/** Является ли форма чтения проекцией рёбер (а не скалярным значением). */
function isLinkValues(entry: PropertyValueEntry): entry is LinkPropertyValues {
  return 'values' in entry && 'count' in entry;
}

/** Сторона ребра по направлению от владельца. */
function sideOfDirection(direction: 'out' | 'in'): LinkPropertySide {
  return direction === 'out' ? 'source' : 'target';
}

/** Сторона строки чтения свойства-связи (явная либо выведенная из направления). */
function sideOfLinkEntry(entry: LinkPropertyValues): LinkPropertySide | null {
  if (entry.side === 'source' || entry.side === 'target') return entry.side;
  return sideOfDirection(entry.direction);
}

/** Строковый набор значения множественного text/url (без пустых элементов). */
function stringItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item !== '');
  }
  if (typeof value === 'string') {
    return value === '' ? [] : [value];
  }
  return [];
}

/** Фрагменты хранимой comma-joined формы множественного text. */
export function splitMultiText(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Канонический адрес кросс-сетевой ссылки для сравнения наборов. */
function canonicalAddress(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item !== null && typeof item === 'object') {
    const snapshot = item as { network_id?: unknown; thought_id?: unknown };
    if (typeof snapshot.network_id === 'string' && typeof snapshot.thought_id === 'string') {
      try {
        return formatCrossNetworkAddress(snapshot.network_id, snapshot.thought_id);
      } catch {
        return `${snapshot.network_id}#${snapshot.thought_id}`;
      }
    }
  }
  return JSON.stringify(item);
}

/** Единственные элементы набора (порядок первого появления сохраняется). */
function uniqueStrings(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Каноническая форма значения одного вида — таблица обработчиков вместо
 * свитча по виду: сторож `guard-value-editor` запрещает диспетчеризацию по
 * `value_type` вне общего редактора значения (здесь не строится поле, но
 * правило то же — вид значения раскладывается в одном месте).
 */
type Canonicalizer = (config: PropertyConfig | null, value: unknown) => string;

/** Скаляр: значение как есть (`false`/`0` — значения, а не «пусто»). */
const scalarCanonical: Canonicalizer = (_config, value) => JSON.stringify(value ?? null);

/** Множество строк без учёта порядка. */
function setCanonical(items: readonly string[]): string {
  return JSON.stringify(uniqueStrings(items).sort());
}

const linkCanonical: Canonicalizer = (_config, value) => setCanonical(stringItems(value));

const textCanonical: Canonicalizer = (config, value) => {
  if (config?.multiple !== true) return scalarCanonical(config, value);
  const items = typeof value === 'string' ? splitMultiText(value) : stringItems(value);
  return setCanonical(items);
};

const urlCanonical: Canonicalizer = (config, value) =>
  config?.multiple === true ? setCanonical(stringItems(value)) : scalarCanonical(config, value);

const crossNetworkCanonical: Canonicalizer = (config, value) => {
  if (!Array.isArray(value)) return scalarCanonical(config, value);
  return setCanonical(value.map(canonicalAddress));
};

const publicationCanonical: Canonicalizer = (config, value) =>
  config?.multiple === true || Array.isArray(value)
    ? setCanonical(stringItems(value))
    : scalarCanonical(config, value);

const CANONICALIZERS: Record<PropertyValueType, Canonicalizer> = {
  text: textCanonical,
  number: scalarCanonical,
  date: scalarCanonical,
  bool: scalarCanonical,
  url: urlCanonical,
  link: linkCanonical,
  thought_ref: scalarCanonical,
  cross_network_ref: crossNetworkCanonical,
  publication: publicationCanonical,
};

/**
 * Каноническая строка значения для сравнения «одинаковы ли наличные».
 * Связь и множественные — множества без учёта порядка; скаляры сравниваются
 * по значению.
 */
export function canonicalBulkValue(
  valueType: PropertyValueType,
  config: PropertyConfig | null,
  value: unknown,
): string {
  return (CANONICALIZERS[valueType] ?? scalarCanonical)(config, value);
}

/** Равны ли два значения свойства по канону {@link canonicalBulkValue}. */
export function bulkValuesEqual(
  valueType: PropertyValueType,
  config: PropertyConfig | null,
  left: unknown,
  right: unknown,
): boolean {
  return canonicalBulkValue(valueType, config, left) === canonicalBulkValue(valueType, config, right);
}

/**
 * Общее значение наличных: все канонические строки совпали — отдаём ПЕРВОЕ
 * значение как хранимую форму; иначе `null` («разные значения»).
 */
export function commonBulkValue(
  valueType: PropertyValueType,
  config: PropertyConfig | null,
  values: readonly unknown[],
): { uniform: boolean; value: unknown | null } {
  if (values.length === 0) return { uniform: true, value: null };
  const first = canonicalBulkValue(valueType, config, values[0]);
  for (let index = 1; index < values.length; index += 1) {
    if (canonicalBulkValue(valueType, config, values[index]) !== first) {
      return { uniform: false, value: null };
    }
  }
  return { uniform: true, value: values[0] ?? null };
}

/** Имя стороны свойства-связи из каталога типов связей. */
function linkSideName(
  linkTypes: readonly BulkLinkType[],
  registry: BulkRegistryProperty,
  side: LinkPropertySide,
): string | null {
  const linkTypeId = registry.config?.link_type_id;
  if (typeof linkTypeId !== 'string' || linkTypeId === '') return null;
  const linkType = linkTypes.find((candidate) => candidate.id === linkTypeId);
  if (linkType === undefined) return null;
  return side === 'source' ? linkType.name_forward : linkType.name_reverse;
}

/** Порядок сторон внутри группы одного свойства. */
function sideOrder(side: LinkPropertySide | null): number {
  if (side === 'source') return 0;
  if (side === 'target') return 1;
  return 0;
}

/**
 * Порядок строк таблицы: по имени реестрового свойства, стороны СВЯЗИ подряд
 * (`source`, затем `target`). Общий компаратор для первичной сборки и
 * добавления строки через (+).
 */
export function compareBulkRows(left: BulkPropertyRow, right: BulkPropertyRow): number {
  const byName = left.sortName.localeCompare(right.sortName, 'ru');
  if (byName !== 0) return byName;
  return sideOrder(left.side) - sideOrder(right.side);
}

/** Отсортированная копия набора строк ({@link compareBulkRows}). */
export function sortBulkRows(rows: readonly BulkPropertyRow[]): BulkPropertyRow[] {
  return [...rows].sort(compareBulkRows);
}

/** Накопитель одной строки во время обхода снимка. */
interface RowAccumulator {
  registry: BulkRegistryProperty;
  side: LinkPropertySide | null;
  presentIds: string[];
  values: unknown[];
  linkTitles: Map<string, string>;
  /** Имя из чтения (direction-aware) — резерв, если каталог типов связей пуст. */
  readName: string | null;
}

/**
 * Строит строки таблицы по снимку чтения.
 *
 * `values` — карта «id мысли → ответ `properties.get`». Порядок результата —
 * по имени реестрового свойства (стороны связи подряд: `source`, затем
 * `target`). Свойства, которых нет в реестре, пропускаются: записать значение
 * по имени такого свойства сервер не даст.
 */
export function buildBulkPropertyRows(args: {
  thoughts: readonly BulkThought[];
  registry: readonly BulkRegistryProperty[];
  linkTypes: readonly BulkLinkType[];
  values: ReadonlyMap<string, readonly PropertyValueEntry[]>;
}): BulkPropertyRow[] {
  const { thoughts, registry, linkTypes, values } = args;
  const registryById = new Map(registry.map((property) => [property.id, property]));
  const accumulators = new Map<string, RowAccumulator>();

  for (const thought of thoughts) {
    const entries = values.get(thought.id) ?? [];
    for (const entry of entries) {
      if (entry.property_id === '') continue;
      const property = registryById.get(entry.property_id);
      if (property === undefined) continue;

      let side: LinkPropertySide | null = null;
      let rowValues: unknown[] = [];
      if (isLinkValues(entry)) {
        // Структурные «Родители»/«Потомки» — не свойство, а дерево.
        if (entry.structural) continue;
        side = sideOfLinkEntry(entry);
        if (side === null) continue;
        // Нулевой счётчик — не значение (типовая привязка без рёбер).
        if (entry.values.length === 0) continue;
        rowValues = [entry.values.map((edge) => edge.target_id)];
      } else {
        rowValues = [entry.value];
      }

      const key = bulkRowKey(entry.property_id, side);
      let accumulator = accumulators.get(key);
      if (accumulator === undefined) {
        accumulator = {
          registry: property,
          side,
          presentIds: [],
          values: [],
          linkTitles: new Map(),
          readName: entry.property_name,
        };
        accumulators.set(key, accumulator);
      }
      accumulator.presentIds.push(thought.id);
      accumulator.values.push(...rowValues);
      if (isLinkValues(entry)) {
        for (const edge of entry.values) {
          if (edge.target_title !== null && !accumulator.linkTitles.has(edge.target_id)) {
            accumulator.linkTitles.set(edge.target_id, edge.target_title);
          }
        }
      }
    }
  }

  const rows: BulkPropertyRow[] = [];
  for (const [key, accumulator] of accumulators) {
    const { registry: property, side } = accumulator;
    const common = commonBulkValue(property.value_type, property.config, accumulator.values);
    const name =
      (side === null ? property.name : linkSideName(linkTypes, property, side)) ??
      accumulator.readName ??
      property.name;
    rows.push({
      key,
      propertyId: property.id,
      side,
      name,
      sortName: property.name,
      valueType: property.value_type,
      config: property.config,
      presentCount: accumulator.presentIds.length,
      totalCount: thoughts.length,
      presentIds: accumulator.presentIds,
      uniform: common.uniform,
      value: common.value,
      linkTitles: accumulator.linkTitles,
      definition: {
        value_type: property.value_type,
        config: property.config,
        required: false,
        default_value: null,
        side,
        key: property.name,
        property_id: property.id,
        ...(property.value_type === 'link'
          ? {
              allowed_opposite_type_ids: registryAllowedOppositeTypeIds(property, side),
            }
          : {}),
      },
    });
  }

  rows.sort(compareBulkRows);
  return rows;
}

/**
 * Строка, добавленная через (+) из справочника: свойства у выделенных ещё нет
 * (K = 0), поле пустое, галочка ставится диалогом.
 */
export function bulkRowFromRegistry(
  property: BulkRegistryProperty,
  side: LinkPropertySide | null,
  linkTypes: readonly BulkLinkType[],
  totalCount: number,
): BulkPropertyRow {
  return {
    key: bulkRowKey(property.id, side),
    propertyId: property.id,
    side,
    name: (side === null ? property.name : linkSideName(linkTypes, property, side)) ?? property.name,
    sortName: property.name,
    valueType: property.value_type,
    config: property.config,
    presentCount: 0,
    totalCount,
    presentIds: [],
    uniform: true,
    value: null,
    linkTitles: new Map(),
    definition: {
      value_type: property.value_type,
      config: property.config,
      required: false,
      default_value: null,
      side,
      key: property.name,
      property_id: property.id,
      ...(property.value_type === 'link'
        ? {
            allowed_opposite_type_ids: registryAllowedOppositeTypeIds(property, side),
          }
        : {}),
    },
  };
}

/**
 * План применения: по одной операции на пару (мысль, отмеченная строка).
 * Галочка + значение — `set` всем обработанным мыслям; галочка + пусто —
 * `remove` только тем, у кого строка была; снятая — ничего.
 */
export function planBulkApply(
  rows: readonly BulkPropertyRow[],
  selection: readonly BulkRowSelection[],
  thoughtIds: readonly string[],
): BulkApplyOperation[] {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const operations: BulkApplyOperation[] = [];
  for (const mark of selection) {
    if (!mark.checked) continue;
    const row = rowsByKey.get(mark.key);
    if (row === undefined) continue;
    const targets =
      mark.value === null
        ? thoughtIds.filter((id) => row.presentIds.includes(id))
        : thoughtIds;
    for (const thoughtId of targets) {
      operations.push({
        rowKey: row.key,
        thoughtId,
        kind: mark.value === null ? 'remove' : 'set',
        propertyKey: row.definition.key,
        propertyId: row.propertyId,
        side: row.side,
        ...(mark.value === null ? {} : { value: mark.value }),
      });
    }
  }
  return operations;
}

/**
 * Сколько мыслей затронет очистка: сумма K по отмеченным строкам с пустым
 * значением. Ноль — подтверждение перед применением не нужно.
 */
export function clearingThoughtCount(
  rows: readonly BulkPropertyRow[],
  selection: readonly BulkRowSelection[],
): number {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  let total = 0;
  for (const mark of selection) {
    if (!mark.checked || mark.value !== null) continue;
    total += rowsByKey.get(mark.key)?.presentCount ?? 0;
  }
  return total;
}

/**
 * Причина ПУСТОГО плана применения — для явного сообщения вместо молчания
 * (ошибка eca9f6d5: «Применить» при 0 операций не говорил ничего, заказчик
 * принял это за неработающую кнопку).
 *
 * - `no-thoughts` — выделенные мысли не прочитаны: применять не к кому;
 * - `no-rows` — ни одна строка не отмечена (путь «применить и закрыть» при
 *   грязной только значением форме);
 * - `no-values` — строки отмечены, но значения пусты, а очищать нечего
 *   (у выделенных этих свойств нет): молчаливый no-op, который и увидел
 *   заказчик.
 *
 * `null` — план не пуст: среди отмеченных строк есть значение.
 */
export type BulkEmptyPlanReason = 'no-thoughts' | 'no-rows' | 'no-values';

export function emptyBulkPlanReason(
  selection: readonly BulkRowSelection[],
  thoughtCount: number,
): BulkEmptyPlanReason | null {
  if (thoughtCount === 0) return 'no-thoughts';
  const checked = selection.filter((mark) => mark.checked);
  if (checked.length === 0) return 'no-rows';
  // Отмеченная строка со значением всегда даёт операции записи.
  if (checked.some((mark) => mark.value !== null)) return null;
  return 'no-values';
}


/**
 * Грязная ли форма относительно исходного снимка: отмечена хоть одна строка
 * либо значение строки отличается от исходного (общего/пустого). Снятая
 * галочка сама по себе «грязью» не считается, но введённое в поле значение —
 * считается: оно потеряется при закрытии.
 */
export function isBulkFormDirty(
  rows: readonly BulkPropertyRow[],
  selection: readonly BulkRowSelection[],
): boolean {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  for (const mark of selection) {
    if (mark.checked) return true;
    const row = rowsByKey.get(mark.key);
    if (row === undefined) continue;
    if (!bulkValuesEqual(row.valueType, row.config, mark.value, row.value)) return true;
  }
  return false;
}

/**
 * Цели связи для редактора значения: `string[]` + подписи из чтения.
 * Редактор принимает и голые id, но чип с подписью читается лучше (сценарий
 * a6b54f0f, шаг 2: «цель M в поле»).
 */
export function bulkLinkEditorValue(
  row: BulkPropertyRow,
  value: unknown,
): LinkPropertyValueItem[] {
  const ids = stringItems(value);
  return ids.map((targetId) => ({
    link_id: '',
    target_id: targetId,
    target_title: row.linkTitles.get(targetId) ?? null,
    target_type_id: null,
    comment: null,
  }));
}
