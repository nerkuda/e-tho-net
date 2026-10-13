/**
 * Виджеты значений условия редактора дерева отбора (задача 3a1f0570 «Списки
 * операторов и виджеты значений», ТП 11b2509a; элементы интерфейса 21955e84
 * «ссылочное значение», 27b2a011 «значение даты», af7bdee2 «количество»,
 * 9ecf405b «Есть слова»; требования 9bdddad6/0882f8d5; ADR 23fab347/30ff83bb).
 *
 * Модуль — ЯЧЕЙКА ЗНАЧЕНИЯ строки условия каркаса `lib/filter-tree.ts`: каркас
 * отдаёт слот через `ctx.renderValue`, хост передаёт сюда
 * {@link createFilterValueRenderer}. Значение живёт в единой модели
 * (`FilterTreeLeaf.value` — дискриминированное {@link FilterTreeValue} из
 * `lib/filter-builder.ts`); своего состояния виджеты не держат.
 *
 * **Значение СВОЙСТВА строит общий редактор** (`editor/value-editor.ts` —
 * единственный в клиенте свитч по `value_type`, стандарт S2, сторож
 * `guard-value-editor`): вид значения читается здесь как ДАННЫЕ реестра
 * (`def.value_type`) и передаётся общему редактору — модуль не строит полей по
 * виду значения сам. Свои виджеты у модуля — только для ролей, которых у
 * значения свойства нет:
 *   • ссылочные ОПЕРАНДЫ («Тип», «Тип связи», «Родители»/«Потомки», «Цели»,
 *     «Ссылка по id», «Сущность») — живой поиск с чипами/комбо (21955e84),
 *     режим «в иерархии» — переключатель В ЯЧЕЙКЕ;
 *   • граница даты ОПЕРАНДА (дата создания/изменения/записи/события) — опоры
 *     списком и сдвиг со знаком, человекочитаемая композиция (27b2a011);
 *   • «Есть слова» — инпут + инлайн-чекбоксы областей (9ecf405b);
 *   • «количество» — числовой инпут с подписью единицы (af7bdee2);
 *   • триада «да / нет / не важно» у операторных предикатов;
 *   • перечисления, которых нет у общего редактора (виды вложения, свойства, а
 *     также каталоги хоста — типы действий, виды сущностей).
 *
 * Переиспользование обязательно (стандарт a2488f05, ADR «Основа lib/ui»):
 * значение свойства — `editor/value-editor.ts`; чип-поле и комбо —
 * `lib/entity-picker.ts`; пользователи — `lib/users.ts`; дата — `lib/date-field.ts`;
 * токены — `lib/period-editor.ts`; поля и переключатели — фасады `lib/ui`.
 */

import {
  filterProfileHasTime,
  type EffectiveTypeProperty,
  type FilterAstOperator,
  type PropertyValueType,
  type FilterProfileId,
  type StructureKeywordScope,
} from '@etn/shared';

import { div, el, span } from './dom.js';
import { buildValueEditor } from '../editor/value-editor.js';
import {
  buildEntityChipField,
  buildEntityCombo,
  filterEntityOptions,
  linkTypeEntityOptions,
  thoughtTypeEntityOptions,
  type EntityChipFieldOptions,
  type EntityKind,
  type EntityOption,
} from './entity-picker.js';
import {
  type FilterTreeLeaf,
  type FilterTreeListItem,
  type FilterTreeValue,
} from './filter-builder.js';
import type { FilterTreeData, FilterTreeValueSlotApi } from './filter-tree.js';
import {
  FILTER_PHRASE_KEYWORD_SCOPES,
  filterPhraseToken,
} from './filter-phrase.js';
import { dateField } from './date-field.js';
import {
  canonicalGlobalToken,
  isGlobalDateToken,
  PERIOD_TOKEN_PRESETS,
  parseBound,
} from './period-editor.js';
import type { SuggestEntry, SuggestSource } from './suggest-dropdown.js';
import { uiButton } from './ui/button.js';
import { choiceRow } from './ui/choice-row.js';
import { fieldInput } from './ui/field.js';
import { segmentedControl } from './ui/segmented.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from './users.js';
import type { ThoughtCloudInput } from './thought-cloud.js';
import { etn } from './etn.js';

// ---------------------------------------------------------------------------
// Классы вида — единственная точка имён (адресуются тестами и CSS)
// ---------------------------------------------------------------------------

/** Корень ячейки значения. */
export const FILTER_VALUE_CLASS = 'fv';
/** Строка условия отключена (ни одной области «Есть слова»). */
export const FILTER_VALUE_OFF_CLASS = 'fv-off';
/** Группа чекбоксов-областей поиска. */
export const FILTER_VALUE_SCOPES_CLASS = 'fv-scopes';
/** Подпись единицы «количества». */
export const FILTER_VALUE_UNIT_CLASS = 'fv-unit';
/** Переключатель режима «в иерархии». */
export const FILTER_VALUE_MODE_CLASS = 'fv-mode';
/** Форма границы даты (опора/сдвиг/точная дата). */
export const FILTER_VALUE_DATE_CLASS = 'fv-date';
/** Опора ячейки даты — список доступных профилю опор. */
export const FILTER_VALUE_ANCHOR_CLASS = 'fv-date__anchor';
/** Поле сдвига опоры — ОДНО число со знаком («+30»/«−30»/«0»). */
export const FILTER_VALUE_SHIFT_CLASS = 'fv-date__shift';
/** Единица сдвига (день/неделя/месяц/год; время — в профилях со временем). */
export const FILTER_VALUE_SHIFT_UNIT_CLASS = 'fv-date__unit';
/** Человекочитаемая композиция границы. */
export const FILTER_VALUE_HINT_LABEL_CLASS = 'fv-date__hint';
/** Сброс границы к «сегодня, 0». */
export const FILTER_VALUE_DATE_RESET_CLASS = 'fv-date__reset';
/** Пара границ оператора «между». */
export const FILTER_VALUE_BOUNDS_CLASS = 'fv-bounds';
/** Приглушённая подпись «значение не требуется». */
export const FILTER_VALUE_HINT_CLASS = 'fv-hint';

// ---------------------------------------------------------------------------
// Классификация редактора (оператор × операнд; вид свойства — данные реестра)
// ---------------------------------------------------------------------------

/** Вид редактора значения листа. */
export type FilterValueEditorKind =
  /** Значение не требуется (`is_empty`/`not_empty`). */
  | 'none'
  /** Значение СВОЙСТВА — общий редактор `editor/value-editor.ts`. */
  | 'value-editor'
  /** Ссылочный операнд (мысль/тип/тип связи/публикация). */
  | 'entity'
  /** Пользователь (автор/редактор). */
  | 'user'
  /** Граница даты/времени оператора. */
  | 'date'
  /** Две границы («между»/«не между»). */
  | 'bounds'
  /** Число значений-«количество» с подписью единицы. */
  | 'count'
  /** «Найти слова»: инпут + области поиска. */
  | 'keywords'
  /** Булев предикат: да / нет (без «не важно»). */
  | 'triad'
  /** Наличие коллекции: (да)/(нет) — оператор в ячейке не показывается. */
  | 'predicate'
  /** «Есть свойства»: чип-поле выбора свойств (ссылочные значения). */
  | 'properties'
  /** Перечисление (чекбоксы из каталога). */
  | 'enum';

/** Вариант перечисления значения (подпись — от хоста либо словаря модуля). */
export interface FilterValueEnumOption {
  value: string;
  label: string;
}

/** Контекст сборки виджета: сеть, профиль и данные списков каркаса. */
export interface FilterValueContext {
  /** Сеть для живого поиска/пикера значений. */
  networkId: string;
  /** Профиль точки применения (состав токенов: время доступно хронике/событиям). */
  profile: FilterProfileId;
  /** Данные сети каркаса (реестр свойств, типы, типы связей). */
  data: FilterTreeData;
  /**
   * Каталог вариантов для перечислений, которые знает только хост (типы
   * действий журнала, виды сущностей). Не задан — вид берётся из словаря модуля
   * либо редактор вырождается в общий редактор значения.
   */
  enumOptions?: (leaf: FilterTreeLeaf) => readonly FilterValueEnumOption[];
  /** Дополнительные источники подсказок хоста (контекстные токены отбора). */
  extraSuggest?: readonly SuggestSource[];
  /** Диалог «выбрать/создать» для ссылочного операнда (угол «…»). */
  picker?: EntityChipFieldOptions['picker'];
  /** Данные облачка значения-мысли (чипы ссылочных операндов). */
  cloudOf?: (value: string) => ThoughtCloudInput | null;
  /** Сообщить хосту о правке ВНЕ значения (области поиска, режим иерархии). */
  touch?: () => void;
}

/** Операторы множественного значения («в списке», наборы). */
const MULTIPLE_OPS: ReadonlySet<FilterAstOperator> = new Set([
  'in',
  'not_in',
  'any_of',
  'all_of',
  'none_of',
]);

/** Операторы «количество» (сравнения числа значений, требование bd0348b3). */
const COUNT_OPS: ReadonlySet<FilterAstOperator> = new Set(['gt', 'gte', 'lt', 'lte']);

/** Значения-перечисления вида вложения (`kind`) — словарь спецификации. */
const ATTACHMENT_KIND_OPTIONS: readonly FilterValueEnumOption[] = [
  { value: 'file', label: 'Файл' },
  { value: 'url', label: 'Ссылка' },
];

/** Ссылочные операнды: значение — мысль/тип/тип связи (элемент 21955e84). */
const ENTITY_OPERANDS: ReadonlySet<string> = new Set([
  'type',
  'link_type',
  'parents',
  'children',
  'targets',
  'id',
  'entity_id',
  'owner',
]);

/** Пользовательские операнды. */
const USER_OPERANDS: ReadonlySet<string> = new Set([
  'author',
  'editor',
  'record_author',
  'record_editor',
  'user',
]);

/** Датовые ОПЕРАНДЫ (значение — дата/время, не свойство). */
const DATE_OPERANDS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
  'record_time',
  'occurred_at',
]);

/** Операторы двух границ. */
export function filterValueIsBounds(operator: FilterAstOperator): boolean {
  return operator === 'between' || operator === 'not_between';
}

/** Требует ли оператор значение (у `is_empty`/`not_empty` значения нет). */
export function filterValueNeedsValue(operator: FilterAstOperator): boolean {
  return operator !== 'is_empty' && operator !== 'not_empty';
}

/** Кратно ли значение (правило «равно только для одиночных», 9bdddad6). */
export function filterValueIsMultiple(operator: FilterAstOperator): boolean {
  return MULTIPLE_OPS.has(operator);
}

/** Оператор сравнивает «количество» значений (а не значение как таковое). */
export function filterValueIsCountShaped(operator: FilterAstOperator): boolean {
  return COUNT_OPS.has(operator) || filterValueIsBounds(operator);
}

/** Строка реестра адресуемого свойства листа (undefined — операнд не свойство). */
export function filterValueRegistryEntry(
  leaf: FilterTreeLeaf,
  data: FilterTreeData,
): EffectiveTypeProperty | undefined {
  const entity = leaf.entity;
  if (entity.kind !== 'property') return undefined;
  const ref = entity.property_id ?? entity.property ?? '';
  const direct = data.registry.get(ref);
  if (direct !== undefined) return registryDefinition(direct);
  for (const entry of data.registry.values()) {
    if (entry.name === ref) return registryDefinition(entry);
  }
  return undefined;
}

/** Определение свойства для общего редактора (сужено до используемых полей). */
function registryDefinition(entry: {
  value_type: PropertyValueType;
  config: unknown;
}): EffectiveTypeProperty {
  return {
    value_type: entry.value_type,
    config: entry.config,
    required: false,
    default_value: null,
    side: null,
    allowed_opposite_type_ids: undefined,
  } as unknown as EffectiveTypeProperty;
}

/**
 * Вид редактора значения листа. Вид СВОЙСТВА читается как данные реестра
 * (`def.value_type`) и передаётся общему редактору — своего свитча по виду
 * значения модуль не заводит (сторож `guard-value-editor`, стандарт S2).
 */
export function filterValueEditor(leaf: FilterTreeLeaf, ctx: FilterValueContext): FilterValueEditorKind {
  const operator = leaf.operator;
  if (!filterValueNeedsValue(operator)) return 'none';
  const kind = leaf.entity.kind;
  const countShaped = filterValueIsCountShaped(operator);
  if (kind === 'keywords') return 'keywords';
  // Булевы предикаты — да/нет (без «не важно»): активность/помеченность — `eq`
  // true/false; наличие коллекции — (да)/(нет) без ячейки оператора.
  if (kind === 'active' || kind === 'trashed') return 'triad';
  if (kind === 'comment' || kind === 'attachments' || kind === 'chronology') return 'predicate';
  // «Есть свойства»: значение — чип-поле выбора свойств, а не список всех с
  // чекбоксами (требование заказчика 2026-10-13).
  if (kind === 'properties') return 'properties';
  // Структурные «Родители»/«Потомки»: числовой оператор — «количество»,
  // иначе выбор мыслей (ссылочный операнд).
  if (kind === 'parents' || kind === 'children') return countShaped ? 'count' : 'entity';
  if (DATE_OPERANDS.has(kind)) return filterValueIsBounds(operator) ? 'bounds' : 'date';
  if (operator === 'has' || operator === 'not_has') return 'enum';
  if (USER_OPERANDS.has(kind)) return 'user';
  if (kind === 'property') {
    const def = filterValueRegistryEntry(leaf, ctx.data);
    if (def === undefined) return 'value-editor';
    // «Количество» ссылки — число рёбер стороны, а не значение-ссылка.
    if (def.value_type === 'link' && countShaped) return 'count';
    if (filterValueIsBounds(operator)) return 'bounds';
    return 'value-editor';
  }
  if (ENTITY_OPERANDS.has(kind)) return filterValueIsBounds(operator) ? 'bounds' : 'entity';
  if (filterValueIsBounds(operator)) return 'bounds';
  if (enumCatalogue(leaf, ctx).length > 0) return 'enum';
  return 'value-editor';
}

/** Варианты перечисления: каталог хоста, словарь модуля либо свойства сети. */
function enumCatalogue(leaf: FilterTreeLeaf, ctx: FilterValueContext): readonly FilterValueEnumOption[] {
  const fromHost = ctx.enumOptions?.(leaf);
  if (fromHost !== undefined) return fromHost;
  if (leaf.entity.kind === 'kind') return ATTACHMENT_KIND_OPTIONS;
  return [];
}

/** Отключено ли условие: «Есть слова» без единой отмеченной области (0882f8d5). */
export function filterValueIsOff(leaf: FilterTreeLeaf): boolean {
  return leaf.entity.kind === 'keywords' && (leaf.entity.scope ?? []).length === 0;
}

/** Области поиска «Есть слова» — словарь спецификации (§6.10 keywords). */
/**
 * Области поиска «Есть слова» (элемент 9ecf405b). Словарь один на клиент — в
 * композере фразы (`lib/filter-phrase.ts`): он же строит подпись областей во
 * фразе-превью, поэтому ячейка и фраза не расходятся.
 */
export const FILTER_VALUE_KEYWORD_SCOPES = FILTER_PHRASE_KEYWORD_SCOPES;

/**
 * Подпись единицы «количества» — что именно считается (элемент af7bdee2).
 * Единица идёт от операнда/природы, а не от значения: «потомков», «вложений».
 */
export function filterValueUnitLabel(leaf: FilterTreeLeaf): string {
  switch (leaf.entity.kind) {
    case 'parents':
      return 'родителей';
    case 'children':
      return 'потомков';
    case 'attachments':
      return 'вложений';
    case 'chronology':
      return 'дневниковых записей';
    default:
      return 'значений';
  }
}

/** Варианты токенов-опор, доступные профилю (без времени — календарные). */
export function filterValueTokenOptions(
  ctx: Pick<FilterValueContext, 'profile'>,
): readonly { text: string; label: string }[] {
  const withTime = filterProfileHasTime(ctx.profile);
  return PERIOD_TOKEN_PRESETS.filter((preset) => withTime || !tokenNeedsTime(preset.text));
}

/** Требует ли токен гранулярности времени (`$now`, единицы `h`/`mi`). */
function tokenNeedsTime(text: string): boolean {
  return /\$now|(?:[+-]\d+(?:h|mi))$/.test(text.trim());
}

/** Источник подсказок токенов-опор для общего редактора значения. */
export function filterValueTokenSource(ctx: FilterValueContext): SuggestSource {
  return {
    when: 'always',
    header: 'Опоры',
    load: (query: string): SuggestEntry[] => {
      const needle = query.trim().toLowerCase();
      return filterValueTokenOptions(ctx)
        .filter((o) => needle === '' || o.label.toLowerCase().includes(needle) || o.text.includes(needle))
        .map((o) => ({ value: o.text, label: o.label }));
    },
  };
}

/** Человекочитаемая подпись значения (композиция опоры и сдвига, элемент 27b2a011). */
export function filterValueHumanLabel(value: FilterTreeValue): string {
  if (value.kind === 'token') return filterPhraseToken(value.token);
  if (value.kind === 'scalar') {
    return typeof value.value === 'string' ? filterPhraseToken(value.value) : String(value.value);
  }
  if (value.kind === 'list') return value.items.map((item) => humanListItem(item)).join(' — ');
  if (value.kind === 'subquery') return `под-выборка (${value.operator})`;
  return '';
}

/** Подпись элемента списка (границы «между», списки значений). */
function humanListItem(item: FilterTreeListItem): string {
  return typeof item === 'object' ? filterPhraseToken(item.token) : String(item);
}

/** Текущее скалярное значение листа строкой ('' — пусто). */
export function filterValueScalarText(value: FilterTreeValue): string {
  if (value.kind === 'scalar') return String(value.value);
  if (value.kind === 'token') return value.token;
  if (value.kind === 'list') {
    const first = value.items[0];
    if (first === undefined) return '';
    return typeof first === 'object' ? first.token : String(first);
  }
  return '';
}

/** Значение-граница по индексу (для «между»: 0 — «С», 1 — «По»). */
export function filterValueBoundAt(value: FilterTreeValue, index: 0 | 1): FilterTreeValue {
  const items = value.kind === 'list' ? value.items : [];
  const item = items[index];
  if (item === undefined) return { kind: 'none' };
  return typeof item === 'object' ? { kind: 'token', token: item.token } : { kind: 'scalar', value: item };
}

/** Модель значения листа → значение для общего редактора. */
export function filterValueToEditor(value: FilterTreeValue): unknown {
  switch (value.kind) {
    case 'scalar':
      return value.value;
    case 'token':
      return value.token;
    case 'list':
      return value.items.map((item) => (typeof item === 'object' ? item.token : item));
    case 'subquery':
    case 'none':
    default:
      return null;
  }
}

/** Значение от общего редактора → модель значения листа. */
export function filterValueFromEditor(next: unknown): FilterTreeValue {
  if (next === null || next === undefined) return { kind: 'none' };
  if (typeof next === 'boolean' || typeof next === 'number') return { kind: 'scalar', value: next };
  if (typeof next === 'string') {
    if (next === '') return { kind: 'none' };
    return next.startsWith('$') ? { kind: 'token', token: next } : { kind: 'scalar', value: next };
  }
  if (Array.isArray(next)) {
    const items = next.filter((v): v is string | number | boolean => typeof v !== 'object');
    return items.length === 0 ? { kind: 'none' } : { kind: 'list', items };
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Сборка виджета значения (слот каркаса)
// ---------------------------------------------------------------------------

/**
 * Фабрика слота значения для каркаса: хост передаёт её в
 * `FilterTreeContext.renderValue`. Профиль и данные сети — из контекста.
 */
export function createFilterValueRenderer(
  ctx: FilterValueContext,
): (leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi) => HTMLElement {
  return (leaf, api) => renderFilterValue(leaf, api, ctx);
}

/** Собрать ячейку значения листа по виду редактора. */
export function renderFilterValue(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const box = div(FILTER_VALUE_CLASS);
  const editor = filterValueEditor(leaf, ctx);
  box.dataset['editor'] = editor;
  if (filterValueIsOff(leaf)) box.classList.add(FILTER_VALUE_OFF_CLASS);
  switch (editor) {
    case 'none':
      box.append(span('значение не требуется', FILTER_VALUE_HINT_CLASS));
      return box;
    case 'triad':
      box.append(triadControl(leaf, api));
      return box;
    case 'predicate':
      box.append(predicateControl(leaf, api));
      return box;
    case 'properties':
      box.append(propertiesControl(leaf, api, ctx));
      return box;
    case 'enum':
      box.append(enumControl(leaf, api, ctx));
      return box;
    case 'keywords':
      box.append(keywordsControl(leaf, api, ctx, box));
      return box;
    case 'count':
      box.append(countControl(leaf, api));
      return box;
    case 'date':
      box.append(dateBoundControl(filterValueScalarText(leaf.value), (value) => api.setValue(value), ctx));
      return box;
    case 'bounds':
      box.append(boundsControl(leaf, api, ctx));
      return box;
    case 'user':
      box.append(userControl(leaf, api));
      return box;
    case 'entity':
      box.append(entityOperandControl(leaf, api, ctx));
      return box;
    default:
      box.append(valueEditorControl(leaf, api, ctx));
      return box;
  }
}

/**
 * Значение СВОЙСТВА — общий редактор (`editor/value-editor.ts`): единственный
 * свитч по виду значения в клиенте. Определение берётся из реестра сети; у
 * неизвестного (удалённого) свойства редактор строится по текстовому виду, а
 * сохранённое значение не теряется — оно уходит в поле как есть.
 */
function valueEditorControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const base =
    filterValueRegistryEntry(leaf, ctx.data) ?? registryDefinition({ value_type: 'text', config: null });
  // Множественность значения задаёт ОПЕРАТОР («в списке»), а не `config.multiple`
  // свойства: у одиночного «Статуса» с оператором «в списке» поле обязано принимать
  // НЕСКОЛЬКО значений (ошибка: разрешено было только одно — требование заказчика
  // 2026-10-13). Для text/url это включает чип-редактор множества.
  const multiple = filterValueIsMultiple(leaf.operator);
  const def: EffectiveTypeProperty =
    multiple && (base.value_type === 'text' || base.value_type === 'url')
      ? { ...base, config: { ...((base.config as Record<string, unknown> | null) ?? {}), multiple: true } }
      : base;
  const extraSuggest: SuggestSource[] = [filterValueTokenSource(ctx), ...(ctx.extraSuggest ?? [])];
  return buildValueEditor({
    networkId: ctx.networkId,
    definition: def,
    value: filterValueToEditor(leaf.value),
    commitOn: 'change',
    textListAsArray: multiple,
    boolTriState: true,
    extraSuggest,
    save: (next) => {
      api.setValue(filterValueFromEditor(next));
      return true;
    },
  });
}

/** Триада булева предиката: да / нет (без «не важно» — требование заказчика). */
function triadControl(leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi): HTMLElement {
  const current =
    leaf.value.kind === 'scalar' && typeof leaf.value.value === 'boolean'
      ? leaf.value.value
        ? 'yes'
        : 'no'
      : 'yes';
  return segmentedControl({
    items: [
      { id: 'yes', label: 'да' },
      { id: 'no', label: 'нет' },
    ],
    activeId: current,
    ariaLabel: 'Значение предиката',
    extraClass: 'fv-triad',
    onChange: (id) => {
      api.setValue({ kind: 'scalar', value: id === 'yes' });
    },
  }).root;
}

/**
 * Наличие коллекции («Есть вложения», «Есть дневниковые записи», «Есть
 * комментарий»): вид «(да) (нет)», оператор в ячейке НЕ показывается — переключение
 * перезаписывает оператор AST (`not_empty`/`is_empty`, требование заказчика
 * 2026-10-13). Коды операторов — из словаря ядра, своих не заводим.
 */
function predicateControl(leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi): HTMLElement {
  const current: 'yes' | 'no' = leaf.operator === 'is_empty' ? 'no' : 'yes';
  return segmentedControl({
    items: [
      { id: 'yes', label: 'да' },
      { id: 'no', label: 'нет' },
    ],
    activeId: current,
    ariaLabel: 'Значение условия',
    extraClass: 'fv-predicate',
    onChange: (id) => {
      leaf.operator = id === 'yes' ? 'not_empty' : 'is_empty';
      leaf.value = { kind: 'none' };
      api.setValue({ kind: 'none' });
    },
  }).root;
}

/**
 * «Есть свойства»: чип-поле выбора свойств (ссылочные значения) — выбранные
 * свойства облачками с крестиками, ввод с живым поиском (требование заказчика
 * 2026-10-13; «список всех свойств с чекбоксами» убран). Значение — список id
 * свойств, оператор `has` (истина — мысль имеет любое из выбранных).
 */
function propertiesControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const wrap = div('fv-properties');
  const options: EntityOption[] = [];
  for (const [id, entry] of ctx.data.registry) options.push({ id, title: entry.name });
  const field = buildEntityChipField({
    getValues: () => currentList(leaf.value),
    onChange: (values) => {
      leaf.operator = 'has';
      api.setValue(values.length === 0 ? { kind: 'none' } : { kind: 'list', items: [...values] });
    },
    initialOptions: options,
    loadOptions: (query) => filterEntityOptions(options, query),
    optionsWhen: 'always',
    optionsHeader: 'Свойства',
    placeholder: 'Добавить свойство…',
  });
  wrap.append(field.root);
  return wrap;
}

/** Перечисление: чекбоксы каталога, значение — список кодов. */
function enumControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const options = enumCatalogue(leaf, ctx);
  const selected = new Set(currentList(leaf.value));
  const box = div('fv-enum');
  for (const option of options) {
    const row = choiceRow({
      kind: 'checkbox',
      label: option.label,
      checked: selected.has(option.value),
      value: option.value,
      onChange: (checked) => {
        if (checked) selected.add(option.value);
        else selected.delete(option.value);
        const items = options.filter((o) => selected.has(o.value)).map((o) => o.value);
        api.setValue(items.length === 0 ? { kind: 'none' } : { kind: 'list', items });
      },
    });
    box.append(row.row);
  }
  return box;
}

/** Текущий список строковых кодов значения. */
function currentList(value: FilterTreeValue): string[] {
  if (value.kind === 'list') {
    return value.items.map((item) => (typeof item === 'object' ? item.token : String(item)));
  }
  if (value.kind === 'scalar') return [String(value.value)];
  if (value.kind === 'token') return [value.token];
  return [];
}

/**
 * «Найти слова»: инпут + инлайн-чекбоксы областей (элемент 9ecf405b). Ни одной
 * области — условие отключено: строка приглушается, значение не применяется
 * (требование 0882f8d5, сервер трактует пустой `scope` как «условие выключено»).
 * «В именах» — имена И синонимы ВМЕСТЕ (требование заказчика 2026-10-13);
 * раздельно они не предлагаются. Оператор условия не показывается.
 */
function keywordsControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
  box: HTMLElement,
): HTMLElement {
  const wrap = div('fv-keywords');
  const input = fieldInput({
    type: 'text',
    value: filterValueScalarText(leaf.value),
    placeholder: 'слова…',
    onChange: (raw: string) => {
      const text = raw.trim();
      api.setValue(text === '' ? { kind: 'none' } : { kind: 'scalar', value: text });
    },
  });
  input.dataset['input'] = 'keywords';
  wrap.append(input);
  const scopes = div(FILTER_VALUE_SCOPES_CLASS);
  const scope = new Set<StructureKeywordScope>(
    leaf.entity.kind === 'keywords' ? (leaf.entity.scope ?? []) : [],
  );
  // Область «в именах» охватывает и имена, и синонимы (сверено с серверным
  // `keyword_scope`: словарь title/synonyms/comment, раздельно не предлагаем).
  const areas: ReadonlyArray<{ label: string; on: boolean; toggle: (checked: boolean) => void }> = [
    {
      label: 'в именах',
      on: scope.has('title') || scope.has('synonyms'),
      toggle: (checked) => {
        for (const name of ['title', 'synonyms'] as const) {
          if (checked) scope.add(name);
          else scope.delete(name);
        }
      },
    },
    {
      label: 'в комментарии',
      on: scope.has('comment'),
      toggle: (checked) => {
        if (checked) scope.add('comment');
        else scope.delete('comment');
      },
    },
  ];
  for (const area of areas) {
    const row = choiceRow({
      kind: 'checkbox',
      label: area.label,
      checked: area.on,
      value: area.label,
      onChange: (checked) => {
        area.toggle(checked);
        if (leaf.entity.kind === 'keywords') leaf.entity.scope = [...scope];
        box.classList.toggle(FILTER_VALUE_OFF_CLASS, scope.size === 0);
        ctx.touch?.();
      },
    });
    scopes.append(row.row);
  }
  wrap.append(scopes);
  return wrap;
}

/** «Количество»: числовой инпут + подпись единицы (элемент af7bdee2). */
function countControl(leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi): HTMLElement {
  if (filterValueIsBounds(leaf.operator)) {
    // «Количество между» — две числовые границы и одна подпись единицы.
    const wrap = div(FILTER_VALUE_BOUNDS_CLASS);
    const from = filterValueBoundAt(leaf.value, 0);
    const to = filterValueBoundAt(leaf.value, 1);
    const push = (next: 0 | 1, bound: FilterTreeValue): void => {
      const items: FilterTreeListItem[] = [
        boundAsItem(next === 0 ? bound : from),
        boundAsItem(next === 1 ? bound : to),
      ];
      api.setValue({ kind: 'list', items });
    };
    wrap.append(numberBound(from, (bound) => push(0, bound)), numberBound(to, (bound) => push(1, bound)));
    wrap.append(span(filterValueUnitLabel(leaf), FILTER_VALUE_UNIT_CLASS));
    return wrap;
  }
  const row = div('fv-number');
  row.append(numberBound(leaf.value, (value) => api.setValue(value)));
  row.append(span(filterValueUnitLabel(leaf), FILTER_VALUE_UNIT_CLASS));
  return row;
}

/** Числовая граница-инпут «количества». */
function numberBound(value: FilterTreeValue, onChange: (value: FilterTreeValue) => void): HTMLElement {
  const input = fieldInput({
    type: 'text',
    value: filterValueScalarText(value),
    placeholder: '0',
    onChange: (raw: string) => {
      const text = raw.trim();
      if (text === '') {
        onChange({ kind: 'none' });
        return;
      }
      onChange(Number.isFinite(Number(text)) ? { kind: 'scalar', value: Number(text) } : { kind: 'scalar', value: raw });
    },
  });
  input.inputMode = 'numeric';
  input.dataset['input'] = 'number';
  return input;
}

/**
 * Граница даты/времени (элемент 27b2a011): [опора ▾] [сдвиг со знаком] [единица ▾]
 * плюс поле точной даты. В модель уходит КАНОНИЧЕСКИЙ токен опоры со сдвигом
 * (`$today+3d`), показ — человекочитаемой композицией; «✕» сбрасывает границу к
 * «сегодня, 0».
 */
function dateBoundControl(
  current: string,
  onChange: (value: FilterTreeValue) => void,
  ctx: FilterValueContext,
): HTMLElement {
  const wrap = div(FILTER_VALUE_DATE_CLASS);
  const exact = current !== '' && !isGlobalDateToken(current) && parseBound(current).kind === 'date';
  const parts = filterValueShiftParts(current);
  // Опора приводится к КАНОНУ: список опор канонический, поэтому легаси-ввод
  // (`$week.start`) не должен оставлять селект без выбранного варианта.
  let anchor = canonicalGlobalToken(parts?.anchor ?? '$today');
  let amount = parts?.amount ?? 0;
  let unit = parts?.unit ?? 'd';
  const anchors = filterValueDateAnchors(ctx);

  const commit = (): void => {
    const token = filterValueComposeShift(anchor, amount, unit);
    onChange({ kind: 'token', token });
  };

  // 1. Опора — список доступных профилю опор (время — только в профилях со временем).
  const anchorSelect = el('select', `${FILTER_VALUE_ANCHOR_CLASS} select-input`) as HTMLSelectElement;
  if (exact) {
    const exactOption = el('option', '', 'точная дата') as HTMLOptionElement;
    exactOption.value = 'exact';
    anchorSelect.append(exactOption);
  }
  for (const option of anchors) {
    const item = el('option', '', option.label) as HTMLOptionElement;
    item.value = option.text;
    anchorSelect.append(item);
  }
  anchorSelect.value = exact ? 'exact' : anchor;
  anchorSelect.dataset['part'] = 'anchor';
  anchorSelect.addEventListener('change', () => {
    if (anchorSelect.value === 'exact') return;
    anchor = anchorSelect.value;
    commit();
  });
  wrap.append(anchorSelect);

  // 2. Сдвиг — одно поле со знаком («+30», «−30», «0»/пусто = без сдвига).
  const shiftInput = fieldInput({
    type: 'text',
    value: amount === 0 ? '' : `${amount > 0 ? '+' : '−'}${Math.abs(amount)}`,
    placeholder: '0',
    title: 'Сдвиг опоры: +30, −30 или 0',
    extraClass: FILTER_VALUE_SHIFT_CLASS,
    onChange: (raw: string) => {
      amount = parseShiftInput(raw);
      commit();
    },
  });
  shiftInput.dataset['part'] = 'shift';
  wrap.append(shiftInput);

  // 3. Единица сдвига — дни/недели/месяцы/годы (время — в профилях со временем).
  const unitSelect = el('select', `${FILTER_VALUE_SHIFT_UNIT_CLASS} select-input`) as HTMLSelectElement;
  for (const option of filterValueShiftUnits(ctx)) {
    const item = el('option', '', option.label) as HTMLOptionElement;
    item.value = option.key;
    unitSelect.append(item);
  }
  unitSelect.value = unit;
  unitSelect.dataset['part'] = 'unit';
  unitSelect.addEventListener('change', () => {
    unit = unitSelect.value;
    commit();
  });
  wrap.append(unitSelect);

  // 4. Точная дата — общий фасад поля даты.
  const field = dateField({
    ...(exact ? { value: current } : {}),
    ariaLabel: 'Точная дата',
    onChange: (iso: string) => onChange(iso === '' ? { kind: 'none' } : { kind: 'scalar', value: iso }),
  });
  wrap.append(field.root);

  // 5. Человекочитаемая композиция и сброс к «сегодня, 0».
  const hint = span(
    current === '' ? '' : filterValueHumanLabel({ kind: 'token', token: current }),
    FILTER_VALUE_HINT_LABEL_CLASS,
  );
  wrap.append(hint);
  wrap.append(
    uiButton({
      label: '✕',
      role: 'ghost',
      size: 's',
      class: FILTER_VALUE_DATE_RESET_CLASS,
      title: 'Сбросить к «сегодня, 0»',
      onClick: () => {
        anchor = '$today';
        amount = 0;
        unit = 'd';
        onChange({ kind: 'token', token: '$today' });
      },
    }),
  );
  return wrap;
}

/** Разобранная опора со сдвигом: `$today+3d` → опора, число и единица. */
export function filterValueShiftParts(token: string): { anchor: string; amount: number; unit: string } | null {
  const text = token.trim();
  if (text === '') return null;
  const m = /^(\$[A-Za-z.]+?)([+-]\d+)(d|w|mo|y|h|mi)$/.exec(text);
  if (m !== null) return { anchor: m[1]!, amount: Number(m[2]), unit: m[3]! };
  return isGlobalDateToken(text) ? { anchor: text, amount: 0, unit: 'd' } : null;
}

/** Канонический токен опоры со сдвигом (нулевой сдвиг — голая опора). */
export function filterValueComposeShift(anchor: string, amount: number, unit: string): string {
  if (amount === 0) return anchor;
  return `${anchor}${amount > 0 ? '+' : '-'}${Math.abs(amount)}${unit}`;
}

/** Разбор поля сдвига: «+30»/«−30»/«30»/«0»/пусто → число (0 — без сдвига). */
function parseShiftInput(raw: string): number {
  const text = raw.trim().replace('−', '-');
  if (text === '' || text === '0' || text === '+0' || text === '-0') return 0;
  const m = /^([+-]?)(\d+)$/.exec(text);
  if (m === null) return 0;
  return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}

/** Опоры ячейки даты — пресеты без сдвига (человекочитаемые подписи). */
export function filterValueDateAnchors(
  ctx: Pick<FilterValueContext, 'profile'>,
): readonly { text: string; label: string }[] {
  return filterValueTokenOptions(ctx).filter((option) => filterValueShiftParts(option.text)?.amount === 0);
}

/** Единицы сдвига: базовые плюс часы/минуты в контекстах со временем. */
export function filterValueShiftUnits(
  ctx: Pick<FilterValueContext, 'profile'>,
): readonly { key: string; label: string }[] {
  const units: { key: string; label: string }[] = [
    { key: 'd', label: 'день' },
    { key: 'w', label: 'неделя' },
    { key: 'mo', label: 'месяц' },
    { key: 'y', label: 'год' },
  ];
  if (filterProfileHasTime(ctx.profile)) {
    units.push({ key: 'h', label: 'час' }, { key: 'mi', label: 'минута' });
  }
  return units;
}

/** Пара границ оператора «между»/«не между». */
function boundsControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const wrap = div(FILTER_VALUE_BOUNDS_CLASS);
  const value = leaf.value;
  const from = filterValueBoundAt(value, 0);
  const to = filterValueBoundAt(value, 1);
  const push = (next: 0 | 1, bound: FilterTreeValue): void => {
    const items: FilterTreeListItem[] = [
      boundAsItem(next === 0 ? bound : from),
      boundAsItem(next === 1 ? bound : to),
    ];
    api.setValue({ kind: 'list', items });
  };
  // Даты/числа свойств — общий редактор (вид значения — данные реестра);
  // датовые операторы — своя ячейка с опорами (элемент 27b2a011).
  const def = filterValueRegistryEntry(leaf, ctx.data);
  if (def === undefined || def.value_type === 'date') {
    const fromBox = dateBoundControl(filterValueScalarText(from), (bound) => push(0, bound), ctx);
    fromBox.dataset['bound'] = 'from';
    const toBox = dateBoundControl(filterValueScalarText(to), (bound) => push(1, bound), ctx);
    toBox.dataset['bound'] = 'to';
    wrap.append(fromBox, toBox);
    return wrap;
  }
  wrap.append(
    boundValueEditor(leaf, def, from, (bound) => push(0, bound), ctx, 'from'),
    boundValueEditor(leaf, def, to, (bound) => push(1, bound), ctx, 'to'),
  );
  return wrap;
}

/** Одна граница «между» для СВОЙСТВА — общий редактор значения. */
function boundValueEditor(
  leaf: FilterTreeLeaf,
  def: EffectiveTypeProperty,
  bound: FilterTreeValue,
  onChange: (value: FilterTreeValue) => void,
  ctx: FilterValueContext,
  side: 'from' | 'to',
): HTMLElement {
  const box = div(FILTER_VALUE_DATE_CLASS);
  box.dataset['bound'] = side;
  box.append(
    buildValueEditor({
      networkId: ctx.networkId,
      definition: def,
      value: filterValueToEditor(bound),
      commitOn: 'change',
      save: (next) => {
        onChange(filterValueFromEditor(next));
        return true;
      },
    }),
  );
  return box;
}

/** Граница как элемент списка значений. */
function boundAsItem(bound: FilterTreeValue): FilterTreeListItem {
  if (bound.kind === 'token') return { token: bound.token };
  if (bound.kind === 'scalar') return bound.value;
  return '';
}

/** Ссылочный ОПЕРАНД: одиночно — комбо, кратно — чип-поле (элемент 21955e84). */
function entityOperandControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const kind = entityKindOf(leaf);
  const multiple = filterValueIsMultiple(leaf.operator);
  const wrap = div('fv-entity');
  wrap.dataset['entityKind'] = kind;
  wrap.dataset['multiple'] = multiple ? 'yes' : 'no';
  // Кнопка «…» — СТАНДАРТНЫЙ диалог поиска/создания мыслей (pickThoughtsDialog,
  // требование заказчика 2026-10-13), а не самодельный диалог entity-picker.
  const picker = ctx.picker ?? defaultEntityPicker(ctx.networkId, kind);

  if (!multiple) {
    const combo = buildEntityCombo({
      networkId: ctx.networkId,
      kind,
      value: filterValueScalarText(leaf.value) === '' ? null : filterValueScalarText(leaf.value),
      placeholder: 'выбрать…',
      ...(picker !== undefined ? { picker } : {}),
      onChange: (id) => {
        api.setValue(id === null || id === '' ? { kind: 'none' } : { kind: 'scalar', value: id });
      },
    });
    wrap.append(combo.root);
  } else {
    const options = staticEntityOptions(kind, ctx);
    const field = buildEntityChipField({
      getValues: () => currentList(leaf.value),
      onChange: (values) => {
        api.setValue(values.length === 0 ? { kind: 'none' } : { kind: 'list', items: [...values] });
      },
      loadOptions: (query) => (options.length > 0 ? filterEntityOptions(options, query) : thoughtsSearch(ctx, query)),
      ...(options.length > 0 ? { initialOptions: options, optionsWhen: 'always' as const } : {}),
      optionsHeader: 'Значения',
      placeholder: 'Добавить значение…',
      ...(ctx.cloudOf !== undefined ? { cloudOf: ctx.cloudOf } : {}),
      ...(picker !== undefined ? { picker } : {}),
    });
    wrap.append(field.root);
  }

  if (leaf.operator === 'in_hierarchy' || leaf.operator === 'not_in_hierarchy') {
    wrap.append(hierarchyModeControl(leaf, ctx));
  }
  return wrap;
}

/**
 * Пикер по умолчанию для ссылочного значения — СТАНДАРТНЫЙ диалог
 * `pickThoughtsDialog` (`canvas/add-dialog.ts`, как в `editor/value-editor.ts`):
 * поиск/создание мыслей, выбранное — id-набор. Импорт динамический, чтобы не
 * заводить статический цикл `canvas → lib` (диалог тяжелее остальных модулей).
 */
function defaultEntityPicker(
  networkId: string,
  kind: EntityKind,
): EntityChipFieldOptions['picker'] | undefined {
  if (kind !== 'thoughts' || networkId === '') return undefined;
  return {
    label: 'Выбрать или создать мысли',
    open: async (managed: readonly string[]): Promise<string[] | null> => {
      const { pickThoughtsDialog } = await import('../canvas/add-dialog.js');
      const result = await pickThoughtsDialog({
        networkId,
        allowCreate: true,
        allowLinkType: false,
        selectedIds: [...managed],
        title: 'Выбрать или создать мысли',
        applyLabel: 'Выбрать',
      });
      if (result === null) return null;
      const ids: string[] = [];
      for (const item of result.items) {
        if (item.kind === 'existing') {
          ids.push(item.id);
          continue;
        }
        try {
          const created = await etn.thoughts.create(networkId, {
            title: item.title,
            synonyms: item.synonyms,
            type_id: result.thoughtTypeId ?? null,
          });
          ids.push(created.id);
        } catch {
          // Ошибку создания не глушим в модель: пользователь повторит выбор.
        }
      }
      return ids;
    },
  };
}

/** Режим обхода «в иерархии» — переключатель В ЯЧЕЙКЕ, не пункт списка (21955e84). */
function hierarchyModeControl(leaf: FilterTreeLeaf, ctx: FilterValueContext): HTMLElement {
  return segmentedControl({
    items: [
      { id: 'structural', label: 'по структуре' },
      { id: 'all_links', label: 'по всем связям' },
    ],
    activeId: leaf.mode ?? 'structural',
    ariaLabel: 'Режим обхода иерархии',
    extraClass: FILTER_VALUE_MODE_CLASS,
    onChange: (id) => {
      leaf.mode = id === 'all_links' ? 'all_links' : 'structural';
      ctx.touch?.();
    },
  }).root;
}

/** Вид ссылочного операнда для пикера/поиска. */
function entityKindOf(leaf: FilterTreeLeaf): EntityKind {
  if (leaf.entity.kind === 'type') return 'thought-types';
  if (leaf.entity.kind === 'link_type') return 'link-types';
  return 'thoughts';
}

/** Статичный каталог вариантов (типы мыслей, типы связей). */
function staticEntityOptions(kind: EntityKind, ctx: FilterValueContext): EntityOption[] {
  if (kind === 'thought-types') return thoughtTypeEntityOptions(ctx.data.thoughtTypes ?? []);
  if (kind === 'link-types') return linkTypeEntityOptions(ctx.data.linkTypes ?? []);
  return [];
}

/** Живой поиск мыслей сети (тот же путь, что у чип-поля панели «Структур»). */
async function thoughtsSearch(ctx: FilterValueContext, query: string): Promise<EntityOption[]> {
  const needle = query.trim();
  if (needle === '' || ctx.networkId === '') return [];
  try {
    const hits = await etn.thoughts.findDuplicates(ctx.networkId, needle, [], []);
    return hits.map((hit) => ({ id: hit.id, title: hit.title, cloud: { ...hit } }));
  } catch {
    return [];
  }
}

/** Автор/редактор: одиночно — выбор пользователя, кратно — мультивыбор. */
function userControl(leaf: FilterTreeLeaf, api: FilterTreeValueSlotApi): HTMLElement {
  const wrap = div('fv-user');
  if (filterValueIsMultiple(leaf.operator)) {
    wrap.append(
      buildUserMultiSelectWidget({
        label: '',
        currentIds: currentList(leaf.value),
        onChange: (ids: string[]) => {
          api.setValue(ids.length === 0 ? { kind: 'none' } : { kind: 'list', items: [...ids] });
        },
      }),
    );
  } else {
    wrap.append(
      buildUserSelectWidget({
        label: '',
        currentId: filterValueScalarText(leaf.value),
        onChange: (id: string) => {
          api.setValue(id === '' ? { kind: 'none' } : { kind: 'scalar', value: id });
        },
      }),
    );
  }
  return wrap;
}
