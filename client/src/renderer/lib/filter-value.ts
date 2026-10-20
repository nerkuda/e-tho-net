/**
 * Виджеты значений условия редактора дерева отбора (задача 3a1f0570 «Списки
 * операторов и виджеты значений», ТП 11b2509a; элементы интерфейса 21955e84
 * «ссылочное значение», 27b2a011 «значение даты», af7bdee2 «количество»,
 * 9ecf405b «Найти слова»; требования 9bdddad6/0882f8d5; ADR 23fab347/30ff83bb).
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
 *   • «Найти слова» — инпут + инлайн-чекбоксы областей (9ecf405b);
 *   • «количество» — числовой инпут с подписью единицы (af7bdee2);
 *   • триада «да / нет / не важно» у операторных предикатов.
 *
 * Перечисления (виды вложения, а также каталоги хоста — типы действий, виды
 * сущностей) строит ТОТ ЖЕ общий редактор значения: синтетическое текстовое
 * определение с `config.multiple` и подписями словаря в `config.options`;
 * единый адаптер {@link filterValueEnumCodec} переводит код AST ↔ подпись
 * (ошибка 1f3f0df5). Своего чип-листа у перечислений нет.
 *
 * Переиспользование обязательно (стандарт a2488f05, ADR «Основа lib/ui»):
 * значение свойства — `editor/value-editor.ts`; чип-поле и комбо —
 * `lib/entity-picker.ts`; пользователи — `lib/users.ts`; дата — `lib/date-field.ts`;
 * токены — `lib/period-editor.ts`; поля и переключатели — фасады `lib/ui`.
 */

import {
  filterProfileHasTime,
  typeNameKey,
  type EffectiveTypeProperty,
  type FilterAstOperator,
  type LinkType,
  type NetworkProperty,
  type PropertyValueType,
  type FilterProfileId,
  type StructureKeywordScope,
} from '@etn/shared';

import { div, el, errText, span } from './dom.js';
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
  FILTER_COLLECTION_PREDICATE_KINDS,
} from './filter-builder.js';
import type { FilterTreeData, FilterTreeValueSlotApi } from './filter-tree.js';
import {
  FILTER_PHRASE_KEYWORD_SCOPES,
  filterKeywordScopeLabel,
  filterPhraseToken,
} from './filter-phrase.js';
// Токены контекста листа — единый каталог (ошибка 50d9bf4e, пункты A3–A6):
// набор по природе операнда/свойства, свойства — из реестра ВСЕЙ сети.
// Перечень пользовательских операндов берётся из того же каталога природы
// (ошибка 23c7d3e9 п. A1) — второго словаря вида значения нет.
import {
  FILTER_USER_OPERAND_KINDS,
  filterLeafTokenSource,
  filterTokenNature,
} from './filter-tokens.js';
import { dateField } from './date-field.js';
import {
  isValidLocalDay,
  resolveDateToken,
  resolveFirstDayOfWeek,
  setPeriodFrom,
  setPeriodTo,
  todayLocal,
  type FirstDayOfWeekSource,
} from './dates.js';
import { VALUE_TYPE_LABELS, valueTypeIconName } from './property-list.js';
import {
  canonicalGlobalToken,
  isGlobalDateToken,
  PERIOD_TOKEN_PRESETS,
  parseBound,
} from './period-editor.js';
import type { SuggestEntry, SuggestSource } from './suggest-dropdown.js';
import { menuAction } from './menu.js';
import { notice } from './notice.js';
import { registerThoughtDropField } from './thought-drop.js';
import type { ThoughtDropPayload } from './thought-drop-pure.js';
import { uiButton } from './ui/button.js';
import type { IconName } from './ui/icon.js';
import { choiceRow } from './ui/choice-row.js';
import { fieldInput } from './ui/field.js';
import { segmentedControl } from './ui/segmented.js';
import { buildUserMultiSelectWidget, buildUserSelectWidget } from './users.js';
import type { ThoughtCloudInput } from './thought-cloud.js';
import { etn } from './etn.js';
import { resolveThoughtRefs } from './thought-ref-batch.js';

// ---------------------------------------------------------------------------
// Классы вида — единственная точка имён (адресуются тестами и CSS)
// ---------------------------------------------------------------------------

/** Корень ячейки значения. */
export const FILTER_VALUE_CLASS = 'fv';
/** Строка условия отключена (ни одной области «Найти слова»). */
export const FILTER_VALUE_OFF_CLASS = 'fv-off';
/** Группа чекбоксов-областей поиска. */
export const FILTER_VALUE_SCOPES_CLASS = 'fv-scopes';
/** Подпись единицы «количества». */
export const FILTER_VALUE_UNIT_CLASS = 'fv-unit';
/** Переключатель режима «в иерархии». */
export const FILTER_VALUE_MODE_CLASS = 'fv-mode';
/** Форма границы даты (опора/сдвиг/точная дата). */
export const FILTER_VALUE_DATE_CLASS = 'fv-date';
/** Общая рамка строки датового виджета: период + количество + тип + крестик. */
export const FILTER_VALUE_DATE_FRAME_CLASS = 'fv-date__frame';
/** Модификатор рамки при выбранной «точной дате» (вместо количества — поле даты). */
export const FILTER_VALUE_DATE_FRAME_EXACT_CLASS = 'fv-date__frame--exact';
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
/**
 * Опора, которую датовая ячейка показывает в ПУСТОЙ границе (`dateBoundControl`:
 * `parts?.anchor ?? '$today'`). Та же опора пишется в модель при правке соседней
 * границы — видимое значение обязано совпасть с записанным (ошибка 99e7889d).
 */
const DATE_BOUND_DEFAULT_TOKEN = '$today';
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
  /**
   * Первый день недели сети (ISO 1 = пн … 7 = вс, требование 1b77decd) —
   * передаётся в календарь диалога «Дата/период» для ячейки точной даты.
   * Допускается функция-резолвер: она читается в момент ОТКРЫТИЯ диалога и при
   * раскрытии границ, поэтому смена настройки сети не оставляет панель со
   * старым значением (ошибка b5278f9a). Не задан — понедельник.
   */
  firstDayOfWeek?: FirstDayOfWeekSource;
  /**
   * Место исполняет отбор относительно мысли-контекста — значениям доступны
   * токены полей мысли (`$thought*`); иначе фокусные токены не предлагаются
   * (требование 3697eb65, признак места `withFocusThought`).
   */
  withFocusThought?: boolean;
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

/** Операторы «в иерархии»/«не в иерархии» (корни поддерева). */
const HIERARCHY_OPS: ReadonlySet<FilterAstOperator> = new Set(['in_hierarchy', 'not_in_hierarchy']);

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

/** Пользовательские операнды — перечень из каталога природы (`lib/filter-tokens.ts`). */
const USER_OPERANDS: ReadonlySet<string> = FILTER_USER_OPERAND_KINDS;

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
  const kind = leaf.entity.kind;
  // Наличие коллекции («Есть вложения»/«Есть дневниковые записи»/«Есть
  // комментарий») — вид «(да) (нет)», и этот вид ЕСТЬ оператор условия
  // (`not_empty` — «да», `is_empty` — «нет»), значения у него нет. Поэтому
  // проверка «оператору значение не требуется» идёт ПОСЛЕ: иначе после клика по
  // «нет» оператор становился `is_empty`, ячейка выбирала вид `none` и
  // переключатели пропадали — вернуть «да» было нельзя (ошибка 23c7d3e9 п. D1).
  if (FILTER_COLLECTION_PREDICATE_KINDS.has(kind)) return 'predicate';
  if (!filterValueNeedsValue(operator)) return 'none';
  const countShaped = filterValueIsCountShaped(operator);
  if (kind === 'keywords') return 'keywords';
  // Булевы предикаты — да/нет (без «не важно»): активность/помеченность — `eq`
  // true/false; наличие коллекции — (да)/(нет) без ячейки оператора.
  if (kind === 'active' || kind === 'trashed') return 'triad';
  // «Есть свойства»: значение — чип-поле выбора свойств, а не список всех с
  // чекбоксами (требование заказчика 2026-10-13).
  if (kind === 'properties') return 'properties';
  // «Имеет свойство»/«не имеет свойство» на любом операнде — тоже набор
  // свойств-значений: у «Типа мысли» (профиль мыслей) раньше не рисовалось
  // поле выбора свойства вовсе (ошибка заказчика 2026-10-14, п.5) — значение
  // «упадало» в перечисление без вариантов. Оба направления оператора дают
  // один вид редактора — чип-поле свойств.
  if (operator === 'has' || operator === 'not_has') return 'properties';
  // Структурные «Родители»/«Потомки»: числовой оператор — «количество»,
  // иначе выбор мыслей (ссылочный операнд).
  if (kind === 'parents' || kind === 'children') return countShaped ? 'count' : 'entity';
  if (DATE_OPERANDS.has(kind)) return filterValueIsBounds(operator) ? 'bounds' : 'date';
  if (USER_OPERANDS.has(kind)) return 'user';
  if (kind === 'property') {
    const def = filterValueRegistryEntry(leaf, ctx.data);
    if (def === undefined) return 'value-editor';
    // «Количество» ссылки — число рёбер стороны, а не значение-ссылка.
    if (def.value_type === 'link' && countShaped) return 'count';
    if (filterValueIsBounds(operator)) return 'bounds';
    // Свойство-дата в операторах сравнения (равно/не равно, больше/меньше,
    // больше-или-равно/меньше-или-равно) — ТА ЖЕ ячейка границы даты, что у дат
    // создания/изменения: опора + арифметика либо точная дата (ошибка e219112e,
    // п.2). Раньше значение набиралось общим редактором сдвига-строки.
    if (def.value_type === 'date') return 'date';
    return 'value-editor';
  }
  if (ENTITY_OPERANDS.has(kind)) return filterValueIsBounds(operator) ? 'bounds' : 'entity';
  if (filterValueIsBounds(operator)) return 'bounds';
  if (enumCatalogue(leaf, ctx).length > 0) return 'enum';
  return 'value-editor';
}

/**
 * Принимает ли ЯЧЕЙКА значение перетаскиваемого вида (этап 3 задачи 31b228f0).
 * ЕДИНСТВЕННЫЙ предикат совместимости: опирается на тот же вид редактора
 * ({@link filterValueEditor}) и определение свойства из реестра — второго
 * словаря совместимости нет (критерий 5; стандарт S2, `guard-value-editor`).
 *
 * - `thought` — ссылочный операнд-мысль (`entity` с родом `thoughts`: «Мысль»,
 *   «Родители»/«Потомки», «Цели») либо значение свойства-связи
 *   (`value-editor` с `value_type: 'link'`, там редактор чипов);
 * - `type` — ссылочный операнд «Тип»/«Тип связи»;
 * - `date` — датовая ячейка (опорный виджет, в т.ч. свойство-дата);
 * - `string` — текстовое/URL-значение свойства.
 */
export function filterValueAcceptsPayload(
  leaf: FilterTreeLeaf,
  ctx: FilterValueContext,
  payload: ThoughtDropPayload,
): boolean {
  const editor = filterValueEditor(leaf, ctx);
  switch (payload.kind) {
    case 'thought':
      if (editor === 'entity') return entityKindOf(leaf) === 'thoughts';
      if (editor === 'value-editor') {
        return filterValueRegistryEntry(leaf, ctx.data)?.value_type === 'link';
      }
      return false;
    case 'type':
      if (editor === 'entity') {
        return leaf.entity.kind === 'type' || leaf.entity.kind === 'link_type';
      }
      return false;
    case 'date':
      return editor === 'date';
    case 'string': {
      // Текстовое значение принимает ЛЮБОЙ текстовый операнд: и свойство
      // реестра (`text`/`url`), и текстовые не-свойства («Имя вложения»,
      // «Заголовок сущности», «Заголовок/Текст записи», MIME-подтип). Природа
      // значения — из ЕДИНОГО каталога операндов (`lib/filter-tokens.ts`),
      // второго словаря совместимости нет.
      if (editor !== 'value-editor') return false;
      return filterTokenNature(leaf, ctx) === 'text';
    }
    default:
      return false;
  }
}

/** Вид значения для объяснения отказа (пользовательский текст). */
const DROP_PAYLOAD_LABELS: Readonly<Record<ThoughtDropPayload['kind'], string>> = {
  thought: 'мысль',
  type: 'тип',
  string: 'строку',
  date: 'дату',
};

/** Объяснение несовместимого броска: модель не меняется, причина видна. */
export function filterValueDropRejectionText(payload: ThoughtDropPayload): string {
  return `Это условие не принимает ${DROP_PAYLOAD_LABELS[payload.kind]}: его значение другого вида`;
}

/**
 * Значение модели для payload. `null` — менять нечего/значение некорректно
 * (приёмник вернёт `false`, модель останется прежней).
 */
function filterValuePayloadValue(
  leaf: FilterTreeLeaf,
  payload: ThoughtDropPayload,
): FilterTreeValue | null {
  switch (payload.kind) {
    case 'thought':
    case 'type': {
      const multiple = filterValueIsMultiple(leaf.operator) || HIERARCHY_OPS.has(leaf.operator);
      if (!multiple) return operandSingleValue(payload.id);
      const current = currentList(leaf.value);
      if (current.includes(payload.id)) return null;
      return operandListValue([...current, payload.id]);
    }
    case 'string': {
      if (payload.value === '') return null;
      // Семантика РУЧНОГО ввода (`filterValueFromEditor`): одиночное значение —
      // литерал либо `$…`-токен. Токены существующего набора при дополнении не
      // выбрасываются: ручное добавление чипа их сохраняет, значит и бросок
      // обязан сохранять (дедупликация и порядок — как у чип-редактора).
      if (!filterValueIsMultiple(leaf.operator)) return filterValueFromEditor(payload.value);
      const current = currentList(leaf.value);
      if (current.includes(payload.value)) return null;
      return { kind: 'list', items: [...current, payload.value] };
    }
    case 'date': {
      if (!isValidLocalDay(payload.value)) return null;
      return { kind: 'scalar', value: payload.value };
    }
    default:
      return null;
  }
}

/**
 * Приёмник значений на ячейке и строке условия (критерий 6). Совместимость —
 * {@link filterValueAcceptsPayload}, значение — {@link filterValuePayloadValue}.
 *
 * Запись идёт СТРУКТУРНЫМ путём ручной правки (`api.setStructuralValue` →
 * `touch()` → полная перерисовка): бросок меняет модель ВНЕ виджета, поэтому
 * «лёгкий» путь значения (`api.setValue` → `touchValue`) оставлял бы ячейку со
 * старым содержимым — модель и сервер новые, DOM старый (блокер проверки этапа
 * 3). Виджеты `entity` перекрывают этот приёмник своим и обновляют разметку
 * сами (чипы/комбо). Несовместимый бросок модель не меняет и объясняет причину
 * тостом; в приёмник панели «Структур» он не проваливается — ближайший
 * зарегистрированный предок (`walkDropField`) остаётся этим.
 */
function acceptFilterValueDrop(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
  payload: ThoughtDropPayload,
): boolean {
  if (!filterValueAcceptsPayload(leaf, ctx, payload)) {
    notice(filterValueDropRejectionText(payload), 'warning');
    return false;
  }
  const value = filterValuePayloadValue(leaf, payload);
  if (value === null) return false;
  (api.setStructuralValue ?? api.setValue)(value);
  return true;
}

/** Варианты перечисления: каталог хоста, словарь модуля либо свойства сети. */
function enumCatalogue(leaf: FilterTreeLeaf, ctx: FilterValueContext): readonly FilterValueEnumOption[] {
  const fromHost = ctx.enumOptions?.(leaf);
  if (fromHost !== undefined) return fromHost;
  if (leaf.entity.kind === 'kind') return ATTACHMENT_KIND_OPTIONS;
  return [];
}

/** Отключено ли условие: «Найти слова» без единой отмеченной области (0882f8d5). */
export function filterValueIsOff(leaf: FilterTreeLeaf): boolean {
  return leaf.entity.kind === 'keywords' && (leaf.entity.scope ?? []).length === 0;
}

/** Области поиска «Найти слова» — словарь спецификации (§6.10 keywords). */
/**
 * Области поиска «Найти слова» (элемент 9ecf405b). Словарь один на клиент — в
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

/**
 * Автокоррекция границ «между» у ДАТ (ошибка 2882c25f, расширено ошибкой
 * 1b6c49fe): интервал не должен «скрещиваться» — ввод «С» позже «По» подтягивает
 * конец к началу, ввод «По» раньше «С» — начало к концу (решение пользователя
 * 2026-10-15). Правило порядка границ — общая точка правды `lib/dates.ts`
 * (`setPeriodFrom`/`setPeriodTo`), та же, что у диалога «Дата/период» и полей
 * «Даты» панели отбора: второго правила не заводим.
 *
 * Сравниваются границы по РЕЗОЛВНУТОМУ локальному дню: конкретная дата — как
 * есть, токен (`$weekEnd`) раскрывается переданным резолвером (тот же, что у
 * «Дневника», с первым днём недели сети). Приоритет — РЕДАКТИРУЕМАЯ граница
 * (как у чистых дат): её представление (дата либо токен) не трогаем, соседнюю
 * при скрещивании подтягиваем к её дню. Токен, который резолвер не раскрыл
 * (или резолвер не передан), и пустая ячейка порядку не подчиняются — прежнее
 * поведение сохраняется.
 */
export function filterValueAlignDateBounds(
  from: FilterTreeListItem,
  to: FilterTreeListItem,
  edited: 0 | 1,
  resolve?: (token: string) => string,
): { from: FilterTreeListItem; to: FilterTreeListItem } {
  const fromDay = boundLocalDay(from, resolve);
  const toDay = boundLocalDay(to, resolve);
  if (fromDay === null || toDay === null) return { from, to };
  if (edited === 0) {
    const aligned = setPeriodFrom(fromDay, toDay, fromDay);
    // Нет скрещивания — исходное представление соседней границы сохраняем
    // (токен остаётся токеном); подтянутая граница становится днём начала.
    return { from, to: aligned.to === toDay ? to : aligned.to };
  }
  const aligned = setPeriodTo(fromDay, toDay, toDay);
  return { from: aligned.from === fromDay ? from : aligned.from, to };
}

/**
 * Автокоррекция ЧИСЛОВЫХ границ «между» (ошибка 07041f80; правило порядка то же,
 * что у дат — `lib/dates.ts` `setPeriodFrom`/`setPeriodTo`, решение пользователя
 * 2026-10-16): ввод «С» больше «По» подтягивает конец к началу, ввод «По» меньше
 * «С» — начало к концу. Приоритет — редактируемая граница (её значение не
 * трогаем). Числовое сравнение — своё (границы дат здесь числа); выравниваются
 * только когда ОБЕ границы — конечные числа: пустая/нечисловая граница порядку
 * не подчиняется (прежнее поведение).
 */
export function filterValueAlignCountBounds(
  from: FilterTreeListItem,
  to: FilterTreeListItem,
  edited: 0 | 1,
): { from: FilterTreeListItem; to: FilterTreeListItem } {
  const fromNum = typeof from === 'number' && Number.isFinite(from) ? from : null;
  const toNum = typeof to === 'number' && Number.isFinite(to) ? to : null;
  if (fromNum === null || toNum === null) return { from, to };
  return edited === 0
    ? { from, to: toNum < fromNum ? fromNum : to }
    : { from: fromNum > toNum ? toNum : from, to };
}

/**
 * Локальный день границы для сравнения порядка: конкретная дата — как есть,
 * токен — через резолвер (не раскрылся — `null`). Нестроковое значение и токен
 * без резолвера дают `null` (граница порядку не подчиняется).
 */
function boundLocalDay(
  item: FilterTreeListItem,
  resolve?: (token: string) => string,
): string | null {
  const token =
    typeof item === 'string'
      ? isValidLocalDay(item)
        ? item
        : item.startsWith('$')
          ? item
          : null
      : typeof item === 'object' && item !== null && 'token' in item
        ? (item as { token: string }).token
        : null;
  if (token === null) return null;
  if (isValidLocalDay(token)) return token;
  if (resolve === undefined) return null;
  const day = resolve(token);
  return isValidLocalDay(day) ? day : null;
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
  // Приёмник перетаскиваемого значения (этап 3 задачи 31b228f0): общий для
  // ячейки и строки условия; виджет `entity` перекрывает его своим (чипы и
  // имена значений), а значение свойства-связи принимает вложенный общий
  // редактор (`editor/value-editor.ts`, регистрация `link-value`).
  const acceptPayload = (payload: ThoughtDropPayload): boolean =>
    acceptFilterValueDrop(leaf, api, ctx, payload);
  api.acceptDrop = acceptPayload;
  registerThoughtDropField(box, {
    kind: 'filter',
    // Читаем `api.acceptDrop` в момент дропа: виджет `entity` перекрывает
    // общий приёмник своим (чипы и имена значений) уже ПОСЛЕ регистрации.
    accept: (id: string): boolean => (api.acceptDrop ?? acceptPayload)({ kind: 'thought', id }),
    acceptPayload: (payload: ThoughtDropPayload): boolean =>
      (api.acceptDrop ?? acceptPayload)(payload),
  });
  switch (editor) {
    case 'none':
      // Значение не требуется («заполнено»/«не заполнено», есть/нет —
      // `filterValueNeedsValue`): поле правого операнда НЕ рисуется, строка
      // «значение не требуется» убрана (требование заказчика 2026-10-14, п.9);
      // ячейка остаётся пустой (data-editor="none").
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
      // Переход «относительная дата → точная» меняет ВИД ячейки (рамка с опорой
      // уступает полю даты с календарём), поэтому запись — структурная; правка
      // опоры/сдвига пересборки не требует, но путь у операнда один.
      box.append(
        dateBoundControl(
          filterValueScalarText(leaf.value),
          (value) => (api.setStructuralValue ?? api.setValue)(value),
          ctx,
        ),
      );
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
  const extraSuggest: SuggestSource[] = [];
  // Опоры-периоды (`$today`/`$weekStart`/…) — только датовой природе: у
  // текстового/ссылочного свойства они нерелевантны, а раньше предлагались
  // всем (ошибка 50d9bf4e п. A4).
  if (filterTokenNature(leaf, ctx) === 'date') extraSuggest.push(filterValueTokenSource(ctx));
  // Токены по природе листа: поля мысли-контекста + `$thought.[Свойство]` по
  // всему реестру сети (пункты A3/A6), без дублей (A5).
  extraSuggest.push(filterLeafTokenSource(leaf, ctx));
  if (ctx.extraSuggest !== undefined) extraSuggest.push(...ctx.extraSuggest);
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
      // Меняется ОПЕРАТОР условия — правка структурная: строка пересобирается
      // (тем же путём, что смена оператора в списке строки).
      (api.setStructuralValue ?? api.setValue)({ kind: 'none' });
    },
  }).root;
}

/**
 * «Есть свойства» и предикат «имеет/не имеет свойство»: чип-поле выбора свойств
 * (ссылочные значения) — выбранные свойства облачками с крестиками, ввод с
 * живым поиском (требование заказчика 2026-10-13; «список всех свойств с
 * чекбоксами» убран). Значение — список id свойств.
 *
 * Строки списка несут ИКОНКУ и ТИП значения свойства — тем же источником, что
 * эталонный список «Мыслесеть → Свойства мыслей» (ошибка заказчика 2026-10-14,
 * п.6а/6б): значок вида значения (связь — сторона) и подпись типа значения
 * рядом с именем; описание свойства — в подсказке. Список шире узкого поля
 * (п.6в).
 *
 * Оператор листа («имеет»/«не имеет свойство») выбор значений НЕ переписывает:
 * иначе «не имеет свойство» молча становился бы «имеет» (ошибка п.5).
 */
function propertiesControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const wrap = div('fv-properties');
  const options = filterPropertyOptions(ctx.data.registry, ctx.data.linkTypes ?? []);
  const field = buildEntityChipField({
    getValues: () => currentList(leaf.value),
    onChange: (values) => {
      api.setValue(values.length === 0 ? { kind: 'none' } : { kind: 'list', items: [...values] });
    },
    initialOptions: options,
    loadOptions: (query) => filterEntityOptions(options, query),
    optionsWhen: 'always',
    optionsHeader: 'Свойства',
    placeholder: 'Добавить свойство…',
    dropdownMinWidth: 420,
  });
  wrap.append(field.root);
  return wrap;
}

/**
 * Варианты чип-поля свойств «Есть свойства»/«имеет свойство» (ошибка заказчика
 * 2026-10-14, п.6): имя свойства, значок вида значения/стороны связи и подпись
 * типа значения рядом с именем — тем же источником, что эталонный список
 * «Мыслесеть → Свойства мыслей»; описание свойства — в подсказке и в поиске.
 * Чистая — юнит-тест.
 */
export function filterPropertyOptions(
  registry: ReadonlyMap<string, NetworkProperty>,
  linkTypes: readonly LinkType[],
): EntityOption[] {
  const out: EntityOption[] = [];
  for (const [id, entry] of registry) {
    const icon = propertyOptionIcon(entry, linkTypes);
    const description = (entry.description ?? '').trim();
    out.push({
      id,
      title: entry.name,
      // Описание ищется живым поиском (как в общем списке свойств).
      ...(description !== '' ? { searchText: description } : {}),
      ...(icon !== null ? { icon } : {}),
      note: VALUE_TYPE_LABELS[entry.value_type],
      ...(description !== '' ? { tooltip: `${entry.name} — ${description}` } : {}),
    });
  }
  return out;
}

/**
 * Значок строки свойства «Есть свойства» (ошибка заказчика 2026-10-14, п.6а):
 * скаляр — значок вида значения, свойство-связь — сторона (назначение — вверх,
 * источник — вниз) — как в списке «Мыслесеть → Свойства мыслей». Источник
 * иконок тот же, что у эталона (`valueTypeIconName`, `lib/property-list.ts`).
 */
function propertyOptionIcon(
  entry: NetworkProperty,
  linkTypes: readonly LinkType[],
): IconName | null {
  if (entry.value_type !== 'link') return valueTypeIconName(entry.value_type);
  const config = entry.config ?? {};
  const linkTypeId = typeof config.link_type_id === 'string' ? config.link_type_id : '';
  const linkType = linkTypes.find((row) => row.id === linkTypeId);
  if (linkType === undefined) return 'arrow-down';
  return typeNameKey(entry.name) === typeNameKey(linkType.name_reverse) ? 'arrow-up' : 'arrow-down';
}

/**
 * Адаптер КОД ↔ ПОДПИСЬ перечисления — один на все перечисления редактора
 * (типы действий журнала, виды сущностей, виды вложения; ошибка 1f3f0df5).
 * AST хранит коды (`created`, `thought`, `file`), а общий редактор значения
 * работает подписями из `config.options` («Создано», «Мысль», «Файл»).
 *
 * Прямое направление показывает подпись; код, которого в словаре уже нет
 * (устаревшее значение), показывается как есть — сохранённые данные не
 * теряются. Обратное направление принимает подпись словаря либо известный код
 * и сообщает, отброшен ли свободный текст: неизвестный ввод в AST не попадает.
 */
export interface FilterValueEnumCodec {
  /** Коды AST → подписи для редактора. */
  toLabels(codes: readonly string[]): string[];
  /**
   * Подписи редактора → коды AST; `dropped` — был неизвестный текст.
   * `keepCodes` — коды, уже показанные ячейкой как есть (устаревшее значение
   * вне словаря): такой текст не свободный ввод, а сохранённый код, и обязан
   * пережить правку.
   */
  toCodes(
    labels: readonly string[],
    keepCodes?: readonly string[],
  ): { codes: string[]; dropped: boolean };
}

/** Собрать адаптер перечисления по словарю вариантов хоста/модуля. */
export function filterValueEnumCodec(
  options: readonly FilterValueEnumOption[],
): FilterValueEnumCodec {
  const labelByCode = new Map<string, string>();
  const codeByLabel = new Map<string, string>();
  for (const option of options) {
    if (labelByCode.has(option.value)) continue;
    labelByCode.set(option.value, option.label);
    if (!codeByLabel.has(option.label)) codeByLabel.set(option.label, option.value);
  }
  return {
    toLabels: (codes) => codes.map((code) => labelByCode.get(code) ?? code),
    toCodes: (labels, keepCodes = []) => {
      const kept = new Set(keepCodes);
      const codes: string[] = [];
      let dropped = false;
      for (const label of labels) {
        // Подпись словаря либо код, который ячейка уже показывает как есть
        // (`toLabels` не нашёл подписи) — обратный путь обязан его сохранить.
        const code = codeByLabel.get(label) ?? (kept.has(label) ? label : undefined);
        if (code === undefined) {
          dropped = true;
          continue;
        }
        if (!codes.includes(code)) codes.push(code);
      }
      return { codes, dropped };
    },
  };
}

/**
 * Перечисление (коды действий журнала, виды сущностей, виды вложений) —
 * СТАНДАРТНЫЙ редактор значения (`editor/value-editor.ts`, ветка `text` +
 * `config.multiple`): рамка `.st-f-chipfield`, компактные чипы, поле
 * `.value-chips-input` с живым поиском по подписям и подсказкой «+ ещё одно
 * значение», каретка «▾» — тот же компонент, что у «Типа места» и строковых
 * свойств со списком (ревизия ошибки 1f3f0df5). Своего чип-листа, чеклиста и
 * кнопки «Выбрать значения…» здесь нет: компонент один на все перечисления.
 *
 * Код ↔ подпись переводит единый адаптер {@link filterValueEnumCodec}. Значение
 * редактора — массив ПОДПИСЕЙ (`textListAsArray: true`), в AST уходят КОДЫ.
 * Неизвестный свободный текст отбрасывается, а ячейка перерисовывается из
 * модели (`setStructuralValue`): редактор успел нарисовать свой чип, и без
 * пересборки «чужой» текст остался бы на экране.
 */
function enumControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const options = enumCatalogue(leaf, ctx);
  const box = div('fv-enum');
  const codec = filterValueEnumCodec(options);
  /** Коды, уже показанные ячейкой (устаревшие значения переживают правку). */
  const shownCodes = currentList(leaf.value);
  box.append(
    buildValueEditor({
      networkId: ctx.networkId,
      // Синтетическое определение значения свойства: перечисление — это
      // текстовое поле с закрытым списком и множественным выбором, поэтому
      // редактор строит ровно тот же вид, что у свойства с `config.options`.
      // Отдельного вида значения у общего редактора не заводим (стандарт S2).
      definition: registryDefinition({
        value_type: 'text',
        config: { multiple: true, options: options.map((option) => option.label) },
      }),
      value: codec.toLabels(shownCodes),
      commitOn: 'change',
      textListAsArray: true,
      save: (next) => {
        const labels = Array.isArray(next)
          ? next.filter((item): item is string => typeof item === 'string')
          : [];
        const { codes, dropped } = codec.toCodes(labels, shownCodes);
        const value = valueFromList(codes);
        if (dropped) {
          // Неизвестный ввод в модель не попадает; пересборка строки убирает
          // уже нарисованный редактором чип с этим текстом.
          (api.setStructuralValue ?? api.setValue)(value);
        } else {
          api.setValue(value);
        }
        return true;
      },
    }),
  );
  return box;
}

/** Значение-набор из списка кодов (пустой список — значение не задано). */
function valueFromList(values: readonly string[]): FilterTreeValue {
  return values.length === 0 ? { kind: 'none' } : { kind: 'list', items: [...values] };
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
 * Значение ОДИНОЧНОГО ссылочного операнда по выбранному id: строка `$…` —
 * токен контекста (форма AST `{ token }`, ошибка 50d9bf4e п. A3), иначе —
 * обычная ссылка-скаляр.
 */
function operandSingleValue(id: string | null): FilterTreeValue {
  if (id === null || id === '') return { kind: 'none' };
  return id.startsWith('$') ? { kind: 'token', token: id } : { kind: 'scalar', value: id };
}

/** Значение МНОЖЕСТВЕННОГО ссылочного операнда: `$…` — токен, прочее — литерал. */
function operandListValue(ids: readonly string[]): FilterTreeValue {
  if (ids.length === 0) return { kind: 'none' };
  return { kind: 'list', items: ids.map((id) => (id.startsWith('$') ? { token: id } : id)) };
}

/**
 * «Найти слова»: инпут + инлайн-чекбоксы областей (элемент 9ecf405b). Три
 * области В ОДНУ СТРОКУ: «в именах», «в комментарии», «в дневниках» (порядок и
 * подписи — из общего словаря `lib/filter-phrase.ts`, он же композер фразы).
 * Ни одной области — условие отключено: строка приглушается, значение не
 * применяется (требование 0882f8d5, сервер трактует пустой `scope` как «условие
 * выключено»). «В именах» — имена И синонимы ВМЕСТЕ (требование заказчика
 * 2026-10-13); раздельно они не предлагаются. «В дневниках» — слова ищутся в
 * хронологических записях мысли (тело или заголовок записи), ищет сервер.
 * Оператор условия не показывается.
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
  // `keyword_scope`: словарь title/synonyms/comment/diary, раздельно не
  // предлагаем). Подписи берутся из общего словаря — ячейка и фраза-превью не
  // расходятся (элемент 9ecf405b); новый код словаря обязан появиться здесь.
  const areas: ReadonlyArray<{ label: string; on: boolean; toggle: (checked: boolean) => void }> = [
    {
      label: filterKeywordScopeLabel('title'),
      on: scope.has('title') || scope.has('synonyms'),
      toggle: (checked) => {
        for (const name of ['title', 'synonyms'] as const) {
          if (checked) scope.add(name);
          else scope.delete(name);
        }
      },
    },
    {
      label: filterKeywordScopeLabel('comment'),
      on: scope.has('comment'),
      toggle: (checked) => {
        if (checked) scope.add('comment');
        else scope.delete('comment');
      },
    },
    {
      label: filterKeywordScopeLabel('diary'),
      on: scope.has('diary'),
      toggle: (checked) => {
        if (checked) scope.add('diary');
        else scope.delete('diary');
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
    // «Количество между» — две числовые границы и одна подпись единицы. Запись
    // структурная: ячейка границ держит собственное состояние частей и
    // пересобирается из модели (ошибка 7d36f439 — обычная правка значения DOM
    // ячейки не пересобирает).
    const wrap = div(FILTER_VALUE_BOUNDS_CLASS);
    const from = filterValueBoundAt(leaf.value, 0);
    const to = filterValueBoundAt(leaf.value, 1);
    // Пара числовых границ выравнивается по порядку (ошибка 07041f80) — тем же
    // правилом, что датовая пара: «С» больше «По» подтягивает конец к началу.
    const push = (next: 0 | 1, bound: FilterTreeValue): void => {
      const aligned = filterValueAlignCountBounds(
        boundAsItem(next === 0 ? bound : from),
        boundAsItem(next === 1 ? bound : to),
        next,
      );
      (api.setStructuralValue ?? api.setValue)({
        kind: 'list',
        items: [aligned.from, aligned.to],
      });
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
 * Граница даты/времени (элемент 27b2a011; переработка по ошибке заказчика
 * 2026-10-14, п.11): ОДНА строка в общей рамке — список периода (первый пункт
 * «Точная дата», далее группа «ОТНОСИТЕЛЬНЫЕ ДАТЫ» с опорами профиля),
 * количество ±N и тип количества; крестик сброса в конце строки. При выборе
 * «Точной даты» вместо количества и типа — поле ввода даты с кнопкой календаря.
 * В модель уходит КАНОНИЧЕСКИЙ токен опоры со сдвигом (`$today+3d`) либо «голая
 * дата»; показ — человекочитаемой подписью ПОД рамкой. Пропорции ширины:
 * период 63%, количество 20%, тип 15%, крестик — остаток (п.11а).
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

  // ЕДИНАЯ рамка строки: все поля и крестик — внутри одного контейнера, у полей
  // своих рамок нет (п.11д).
  const frame = div(FILTER_VALUE_DATE_FRAME_CLASS);
  if (exact) frame.classList.add(FILTER_VALUE_DATE_FRAME_EXACT_CLASS);

  // 1. Период — первый пункт «Точная дата», далее группа «ОТНОСИТЕЛЬНЫЕ ДАТЫ»
  //    со всеми опорами профиля (п.11в).
  const anchorSelect = el('select', `${FILTER_VALUE_ANCHOR_CLASS} select-input`) as HTMLSelectElement;
  const exactOption = el('option', '', 'Точная дата') as HTMLOptionElement;
  exactOption.value = 'exact';
  anchorSelect.append(exactOption);
  const group = el('optgroup', '') as HTMLOptGroupElement;
  group.label = 'ОТНОСИТЕЛЬНЫЕ ДАТЫ';
  const offered = new Set<string>();
  for (const option of anchors) {
    const item = el('option', '', option.label) as HTMLOptionElement;
    item.value = option.text;
    offered.add(option.text);
    group.append(item);
  }
  // Текущая опора вне списка пресетов (легаси/составная `$today+3d`) — своим
  // пунктом, иначе селект показывал бы первую опору списка вместо неё.
  if (!exact && !offered.has(anchor)) {
    const item = el('option', '', anchor) as HTMLOptionElement;
    item.value = anchor;
    group.append(item);
  }
  anchorSelect.append(group);
  anchorSelect.value = exact ? 'exact' : anchor;
  anchorSelect.dataset['part'] = 'anchor';
  anchorSelect.addEventListener('change', () => {
    if (anchorSelect.value === 'exact') {
      // Переход к точной дате: значением ставим сегодняшнюю дату — ячейка
      // перерисуется полем даты с календарём (п.11г).
      onChange({ kind: 'scalar', value: todayLocal() });
      return;
    }
    // Выбор опоры из списка — это выбор ПРЕСЕТА-ТОКЕНА без сдвига: остаток
    // прежнего сдвига молча превращал выбранную опору в другой токен
    // (`$monthStart` из ячейки `$today-4d` давал `$monthStart-4d` — ошибка
    // c4343d63, период разъезжался). Пресет опоры и должен записаться ровно им;
    // сдвиг пользователь задаёт отдельным полем ПОСЛЕ выбора опоры.
    anchor = anchorSelect.value;
    amount = 0;
    unit = 'd';
    commit();
  });
  frame.append(anchorSelect);

  if (exact) {
    // 2. Точная дата — поле ввода даты + кнопка существующего календаря (п.11г).
    //    Крестик поля не рисуем: очистка/сброс — одна кнопка строки.
    const field = dateField({
      value: current,
      ariaLabel: 'Точная дата',
      hideClear: true,
      onPick: exactDatePicker(current, ctx),
      onChange: (iso: string) => onChange(iso === '' ? { kind: 'none' } : { kind: 'scalar', value: iso }),
    });
    frame.append(field.root);
  } else {
    // 2. Количество (сдвиг) — одно поле со знаком («+30», «−30», «0»/пусто).
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
    // 3. Тип количества — сокращённые подписи: дн/нед/мес/год/час/мин (п.11б).
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
    frame.append(shiftInput, unitSelect);
  }

  // 4. Крестик сброса — в конце строки (п.11а).
  frame.append(
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
  wrap.append(frame);

  // 5. Человекочитаемая подпись раскрытия — под рамкой (сохранена, п.11).
  wrap.append(
    span(
      current === '' ? '' : filterValueHumanLabel({ kind: 'token', token: current }),
      FILTER_VALUE_HINT_LABEL_CLASS,
    ),
  );
  return wrap;
}

/** Открыть существующий календарь для точной даты; `null` — отказ от выбора. */
function exactDatePicker(
  current: string,
  ctx: Pick<FilterValueContext, 'firstDayOfWeek'>,
): () => Promise<string | null> {
  return async (): Promise<string | null> => {
    const fallback = /^\d{4}-\d{2}-\d{2}$/.test(current) ? current : todayLocal();
    const { openDatePeriodDialog } = await import('./date-period-dialog.js');
    const result = await openDatePeriodDialog({
      allowPeriod: false,
      allowTime: false,
      title: 'Точная дата',
      initial: { mode: 'date', from: fallback, to: fallback },
      // Настройка сети читается В МОМЕНТ открытия: панель могла быть собрана
      // до смены первого дня недели в «Все настройки» (ошибка b5278f9a).
      firstDayOfWeek: resolveFirstDayOfWeek(ctx.firstDayOfWeek),
    });
    return result === null ? null : result.from;
  };
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

/**
 * Единицы сдвига: базовые плюс часы/минуты в контекстах со временем. Подписи
 * СОКРАЩЁННЫЕ — дн/нед/мес/год/час/мин (ошибка заказчика 2026-10-14, п.11б):
 * длинные подписи не помещались в узкой ячейке строки.
 */
export function filterValueShiftUnits(
  ctx: Pick<FilterValueContext, 'profile'>,
): readonly { key: string; label: string }[] {
  const units: { key: string; label: string }[] = [
    { key: 'd', label: 'дн' },
    { key: 'w', label: 'нед' },
    { key: 'mo', label: 'мес' },
    { key: 'y', label: 'год' },
  ];
  if (filterProfileHasTime(ctx.profile)) {
    units.push({ key: 'h', label: 'час' }, { key: 'mi', label: 'мин' });
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
  const from = filterValueBoundAt(leaf.value, 0);
  const to = filterValueBoundAt(leaf.value, 1);
  // Даты/числа свойств — общий редактор (вид значения — данные реестра);
  // датовые операторы — своя ячейка с опорами (элемент 27b2a011).
  const def = filterValueRegistryEntry(leaf, ctx.data);
  const dateCell = def === undefined || def.value_type === 'date';
  /**
   * Чем заполняется ячейка границы, не записанная в модель. У датовой ячейки
   * пустая граница ПОКАЗЫВАЕТ опору `$today` (`dateBoundControl`: `parts?.anchor
   * ?? '$today'`) — видимое значение обязано попасть в модель (автоподстановка,
   * ошибка 609deba0 п.3). Пустая строка в список границ не пишется: сервер
   * отвергает её («Граница даты должна быть непустой строкой ISO-8601», ошибка
   * 99e7889d) — так «между $weekStart и $today» с нетронутой второй ячейкой
   * уходило как `[{token:"$weekStart"}, ""]`.
   */
  const missing: FilterTreeListItem = dateCell ? { token: DATE_BOUND_DEFAULT_TOKEN } : '';
  // Резолвер границ-токенов для выравнивания: тот же, что у «Дневника» (первый
  // день недели сети, требование 1b77decd) — сравнение границ идёт по резолвнутому
  // дню (ошибка 1b6c49fe).
  const resolveDay = dateCell
    ? (token: string): string =>
        resolveDateToken(token, todayLocal(), resolveFirstDayOfWeek(ctx.firstDayOfWeek))
    : undefined;
  // Запись границы — структурная (ошибка 7d36f439): ячейка границ держит
  // собственное состояние частей (опора/сдвиг/единица, точная дата) и
  // пересобирается из модели. Пару границ выравниваем по порядку ДАТ
  // (ошибка 2882c25f; токены — по резолвнутому дню, ошибка 1b6c49fe) — пустые
  // границы не трогаются.
  const push = (next: 0 | 1, bound: FilterTreeValue): void => {
    const aligned = filterValueAlignDateBounds(
      boundAsItem(next === 0 ? bound : from, missing),
      boundAsItem(next === 1 ? bound : to, missing),
      next,
      resolveDay,
    );
    (api.setStructuralValue ?? api.setValue)({ kind: 'list', items: [aligned.from, aligned.to] });
  };
  if (dateCell) {
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

/**
 * Граница как элемент списка значений. `missing` — чем представлена граница,
 * которой в модели ещё нет (пустая ячейка): датовая ячейка показывает опору
 * `$today` и обязана писать её в модель, у прочих природ значение не выдумывается
 * (пустой элемент ловит проверка конструктора «условие без значения»).
 */
function boundAsItem(
  bound: FilterTreeValue,
  missing: FilterTreeListItem = '',
): FilterTreeListItem {
  if (bound.kind === 'token') return { token: bound.token };
  if (bound.kind === 'scalar') return bound.value;
  return missing;
}

/**
 * Снапшоты имён выбранных значений листа: карта `labels.values` (id → имя) и, для
 * одиночного значения, ещё `labels.value` (совместимость с сохранёнными
 * отборами и сообщениями диагностики). Композер фразы показывает ИМЯ вместо id
 * для КАЖДОГО значения набора (ошибка 4258e694 п.12б). Пустая карта снимает
 * снапшоты.
 */
function setLeafValueLabels(leaf: FilterTreeLeaf, names: ReadonlyMap<string, string>): void {
  const labels = { ...(leaf.labels ?? {}) };
  const values: Record<string, string> = {};
  for (const [id, name] of names) {
    if (name !== '') values[id] = name;
  }
  if (Object.keys(values).length === 0) {
    delete labels.values;
    delete labels.value;
  } else {
    labels.values = values;
    if (names.size === 1) labels.value = [...names.values()][0]!;
    else delete labels.value;
  }
  leaf.labels =
    labels.entity === undefined && labels.value === undefined && labels.values === undefined
      ? undefined
      : labels;
}

/** Совпадают ли наборы значений (порядок значим — он же порядок чипов). */
function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// ---------------------------------------------------------------------------
// Меню чипа-мысли условия отбора (ошибка ada6a69d)
// ---------------------------------------------------------------------------

/** Опции контекстного меню чипа-мысли в условии отбора. */
export interface FilterThoughtMenuOptions {
  networkId: string;
  /** id мысли — значение условия. */
  id: string;
  /** Полное имя значения (подпись меню). */
  title: string;
  /** Мысль помечена на удаление — подпись «Удалить/восстановить» (S13). */
  trashed?: boolean;
  /** Якорь меню — сам чип. */
  anchor: Element;
  /** Убрать это значение из условия (прямой аналог «✕» чипа). */
  onRemoveFromValue: () => void;
}

/** Выполняет отложенную операцию, показывая сбой тостом (как чипы редактора). */
function lazily(run: () => Promise<unknown>): void {
  void run().catch((err: unknown) => notice(errText(err), 'error'));
}

/** Открыть мысль в текущем редакторе, не сдвигая фокус холста (контекст условия). */
function openThoughtInEditorById(id: string): void {
  lazily(async () => {
    const { openThoughtInEditor } = await import('../editor/editor.js');
    openThoughtInEditor(id);
  });
}

/** Поставить мысль в фокус и показать карту мыслей (общий помощник, 562356a9). */
function focusThoughtOnMapById(id: string): void {
  lazily(async () => {
    const { focusThoughtOnMap } = await import('../screens/active-view.js');
    await focusThoughtOnMap(id);
  });
}

/**
 * Есть ли мысль в сети. Значение условия живёт и по снапшоту имени, когда мысли
 * уже нет (удалена) — такому чипу общий набор команд не годится: почти все
 * команды упали бы 404 (решение по ошибке ada6a69d). Сбой резолва урезанию не
 * повод: считаем мысль доступной.
 */
async function thoughtAvailable(networkId: string, id: string): Promise<boolean> {
  try {
    const refs = await etn.thoughts.resolve(networkId, [id]);
    return refs.some((ref) => ref.id === id);
  } catch {
    return true;
  }
}

/**
 * Контекстное меню чипа-МЫСЛИ в условиях отбора: набор команд — ОБЩИЙ
 * (`canvas/context-menu.ts` — единственный конструктор меню мысли; второй
 * рукописный список команд недопустим, грабли f072db61). Отличия контекста
 * задаются его опциями: «Открыть в редакторе» (мысль открывается в текущем
 * редакторе, фокус холста не сдвигается), «В фокус» и команда значения
 * «Убрать из значения условия» (аналог «✕»). Недоступной в сети мысли —
 * урезанный набор (`unresolvable`). Импорт ленивый: статический замкнул бы цикл
 * `canvas/context-menu → editor/editor → lib/filter-value`.
 *
 * Сбои (в т.ч. отложенный импорт) уходят тостом: функция ничего не возвращает и
 * не отклоняется — вызывающий не обязан держать `catch`.
 */
export function openFilterThoughtMenu(opts: FilterThoughtMenuOptions): void {
  lazily(async () => {
    const { showThoughtMenuUnder, resolveSiblingParentId } =
      await import('../canvas/context-menu.js');
    // Родитель для «налево (родственник)» и доступность мысли — параллельно.
    const [siblingParentId, available] = await Promise.all([
      resolveSiblingParentId(opts.networkId, opts.id),
      thoughtAvailable(opts.networkId, opts.id),
    ]);
    wireFilterCloudInvalidation();
    showThoughtMenuUnder(
      opts.anchor,
      {
        id: opts.id,
        title: opts.title,
        dir: 'siblings',
        // Чип не живёт в зоне холста — родителя резолвим запросом (как чипы
        // редактора: value-editor).
        siblingParentId,
        trashed: opts.trashed === true,
      },
      {
        openLabel: 'Открыть в редакторе',
        openHandler: (id) => openThoughtInEditorById(id),
        focusHandler: () => focusThoughtOnMapById(opts.id),
        extraItems: [menuAction('Убрать из значения условия', opts.onRemoveFromValue)],
        ...(available ? {} : { unresolvable: true }),
      },
    );
  });
}

/** Метка корзины чипа-мысли — двухфазный диалог «Удалить/Восстановить». */
export async function openFilterThoughtTrashDialog(
  networkId: string,
  id: string,
  title: string,
): Promise<void> {
  const { openThoughtDeleteDialog } = await import('../trash.js');
  await openThoughtDeleteDialog(networkId, { id, title });
}

/**
 * Живой снапшот облачков виджета отбора: по сигналу сброса ref-кэша мыслей
 * снапшот пересобирается, чипы перерисовываются (грабля 48f35eba).
 */
export interface FilterCloudSnapshot {
  /** Корень виджета: снятый со страницы снапшот снимается с подписки лениво. */
  readonly root: HTMLElement;
  /**
   * Данные мысли `id` (`null` — все значения) устарели. `realtime` — сигнал
   * пришёл из волны событий: догрузка id коалесируется в окне, действие
   * пользователя (команда меню) — нет.
   */
  invalidate(id: string | null, realtime?: boolean): void;
}

const filterCloudSnapshots = new Set<FilterCloudSnapshot>();
let filterCloudInvalidationWired = false;

/**
 * Регистрирует снапшот облачков виджета отбора. Команды контекстного меню
 * (актуальность, тип, иконка, удаление/восстановление) и realtime меняют данные
 * мысли — снапшот обязан пересобраться из модели, а не «поправить значение в
 * замыкании» (грабля 48f35eba). Сигнал — точечный сброс ref-кэша
 * (`onThoughtRefInvalidated`), а не весь store: подписка на каждое событие
 * магазина заставляла бы панель мигать (ошибка 3a64e680).
 */
export function watchFilterClouds(snapshot: FilterCloudSnapshot): void {
  filterCloudSnapshots.add(snapshot);
}

/** Подписка на сброс ref-кэша — один раз на процесс, лениво (первое меню). */
function wireFilterCloudInvalidation(): void {
  if (filterCloudInvalidationWired) return;
  filterCloudInvalidationWired = true;
  void import('../canvas/canvas.js')
    .then(({ onThoughtRefInvalidated }) => {
      onThoughtRefInvalidated((id, realtime) => {
        for (const snapshot of [...filterCloudSnapshots]) {
          if (!snapshot.root.isConnected) {
            filterCloudSnapshots.delete(snapshot);
            continue;
          }
          snapshot.invalidate(id, realtime === true);
        }
      });
    })
    .catch(() => undefined);
}

/** Ссылочный ОПЕРАНД: одиночно — комбо, кратно — чип-поле (элемент 21955e84). */
function entityOperandControl(
  leaf: FilterTreeLeaf,
  api: FilterTreeValueSlotApi,
  ctx: FilterValueContext,
): HTMLElement {
  const kind = entityKindOf(leaf);
  const hierarchyOp = HIERARCHY_OPS.has(leaf.operator);
  // «Мысль» (`id`) и «Цели записи» (`targets`) в иерархии: режим связей
  // неприменим — обход только по структурным потомкам (задача a577875b; «Цели»
  // зеркалят «Мысль» — ошибка 609deba0 п.1), поэтому ячейка режима не рисуется.
  const structuralOnlyHierarchy =
    hierarchyOp && (leaf.entity.kind === 'id' || leaf.entity.kind === 'targets');
  // «В иерархии»/«не в иерархии» — МНОЖЕСТВЕННЫЙ выбор корней, ровно как «в
  // списке» (требование заказчика 2026-10-14, ошибка f4e99090 п.4): сервер
  // принимает массив корней для любого иерархического операнда (задача
  // a577875b — паритет с OR-группой). Одиночного значения у этих операторов
  // больше нет.
  const multiple = filterValueIsMultiple(leaf.operator) || hierarchyOp;
  const wrap = div('fv-entity');
  wrap.dataset['entityKind'] = kind;
  wrap.dataset['multiple'] = multiple ? 'yes' : 'no';
  // Кнопка «…» — СТАНДАРТНЫЙ диалог поиска/создания мыслей (pickThoughtsDialog,
  // требование заказчика 2026-10-13), а не самодельный диалог entity-picker.
  const picker = ctx.picker ?? defaultEntityPicker(ctx.networkId, kind);

  // Имена вариантов, показанных живым поиском/пикером (id → имя): по ним фраза
  // показывает ИМЯ мысли, а не id (ошибка 4258e694 п.12б).
  const titles = new Map<string, string>();
  // Данные облачков выбранных значений (id → мысль): чип обязан показывать
  // ЗНАЧОК и ИМЯ, а не голый id — и при выборе в диалоге «…» (он возвращает
  // только id), и для сохранённых значений до первого живого поиска. Догрузка —
  // пакетным `etn.thoughts.resolve`, как у значения свойства-связи
  // (`editor/value-editor.ts`) и у секции корней поддерева
  // (`lib/filter-form.ts`): единый вид чипа-мысли (ошибка f4e99090 п.5).
  const clouds = new Map<string, ThoughtCloudInput>();
  /** Чип-поле значения — нужно для перерисовки чипов после догрузки облачков. */
  let fieldRef: { refresh: () => void } | null = null;
  const cloudOf = (value: string): ThoughtCloudInput | null =>
    ctx.cloudOf?.(value) ?? clouds.get(value) ?? null;
  /**
   * СИНХРОННОЕ имя значения для чипа (ошибка f4e99090: замер верификатора —
   * голый UUID ~37 мс до ответа `etn.thoughts.resolve` и навсегда при его
   * сбое). Источники по старшинству: известное варианту имя (каталог/живой
   * поиск) и снапшот самой модели `labels.values` (механизм 5bf3d291).
   * `leaf.labels` читается ЛЕНИВО — имя есть уже при построении чипа и после
   * правки значения, не дожидаясь резолва; сбой резолва последнее известное имя
   * не сбрасывает, до сырого id дело доходит лишь когда имя неизвестно вовсе.
   */
  const titleOf = (value: string): string | null => {
    const known = titles.get(value);
    if (known !== undefined && known !== '') return known;
    const fromMap = leaf.labels?.values?.[value];
    return fromMap !== undefined && fromMap !== '' ? fromMap : null;
  };

  const rememberOptions = (loaded: readonly EntityOption[]): EntityOption[] => {
    // Имена вариантов живой подсказки — синхронный источник имени чипа: чип-поле
    // кладёт облачко варианта в свой `byId`, а имя дублируем сюда для `titleOf`.
    for (const option of loaded) titles.set(option.id, option.title);
    return [...loaded];
  };

  /**
   * Пересобрать облачка значений (значок+имя чипа) пакетным
   * `etn.thoughts.resolve` — только те id, которых ещё нет в кеше. Нужна и для
   * НАЧАЛЬНОЙ отрисовки сохранённого значения (живого поиска ещё не было, и без
   * догрузки чип показывал бы голый id — ошибка f4e99090 п.5), и для
   * инвалидации снапшота после команд контекстного меню: снапшот — производное
   * от модели, он пересобирается из неё, а не правится в замыкании (грабля
   * 48f35eba). Перерисовку обещает сам резолв: пустой ответ (мысль удалена)
   * тоже обязан обновить чип.
   */
  const fillClouds = (values: readonly string[], realtime = false): void => {
    if (kind !== 'thoughts' || ctx.networkId === '') return;
    const missing = values.filter((id) => id !== '' && !id.startsWith('$') && !clouds.has(id));
    if (missing.length === 0) return;
    // Батчер собирает затронутые волной id от ВСЕХ виджетов и делает один
    // `thoughts.resolve` по окну; действия пользователя уходят в микротаске.
    void resolveThoughtRefs(ctx.networkId, missing, { windowed: realtime })
      .then((refs) => {
        for (const ref of refs) clouds.set(ref.id, { ...ref });
      })
      .catch(() => undefined)
      .finally(() => fieldRef?.refresh());
  };

  /**
   * Данные мысли изменились (команда контекстного меню или realtime): снапшот
   * облачков затронутых значений инвалидируется, чипы перерисовываются из
   * модели (грабля 48f35eba). `id` — конкретная мысль, `null` — все значения.
   */
  const invalidateClouds = (id: string | null, realtime = false): void => {
    const values = currentList(leaf.value);
    const affected = values.filter(
      (value) => value !== '' && !value.startsWith('$') && (id === null || value === id),
    );
    if (affected.length === 0) return;
    for (const value of affected) clouds.delete(value);
    fillClouds(values, realtime);
  };

  /** Полное имя значения для меню: снапшот данных → имя варианта → сырой id. */
  const menuTitle = (value: string): string =>
    cloudOf(value)?.title ?? titleOf(value) ?? value;

  /** Мысль помечена на удаление — меню подпишет «Удалить/восстановить» (S13). */
  const menuTrashed = (value: string): boolean =>
    cloudOf(value)?.marked_for_deletion === true;

  /**
   * Записать снапшоты имён выбранных значений по id: имена известных вариантов и
   * снапшотов модели — сразу (на КАЖДОЕ значение набора), незнакомые (выбор в
   * диалоге «…» даёт только id) — пакетным резолвом. Вызывается ДО записи
   * значения (`api.setValue`), чтобы фраза перечиталась с именами на одном
   * `touch`; догруженный резолв зовёт `touch` и обновляет чипы сам.
   */
  const applyValueLabel = (values: readonly string[]): void => {
    const names = new Map<string, string>();
    const missing: string[] = [];
    for (const id of values) {
      if (id === '' || id.startsWith('$')) continue; // токены имён не имеют
      // Источник — тот же, что у чипа (`titleOf`): снапшот модели сохраняется и
      // при правке набора, а не сбрасывается в ожидание резолва (ошибка
      // f4e99090: при сбое резолва имя терялось).
      const known = titleOf(id);
      if (known !== null) names.set(id, known);
      else missing.push(id);
    }
    setLeafValueLabels(leaf, names);
    if (missing.length === 0 || kind !== 'thoughts' || ctx.networkId === '') return;
    // Значение листа уже записано (setValue идёт следом синхронно) — резолв
    // ставим только если лист всё ещё держит ТОТ ЖЕ набор значений.
    void etn.thoughts
      .resolve(ctx.networkId, missing)
      .then((refs) => {
        if (!sameValues(currentList(leaf.value), values)) return;
        const next = new Map(names);
        for (const ref of refs) {
          titles.set(ref.id, ref.title);
          clouds.set(ref.id, { ...ref });
          if (values.includes(ref.id)) next.set(ref.id, ref.title);
        }
        const grew = next.size !== names.size;
        if (grew) setLeafValueLabels(leaf, next);
        if (refs.length > 0) fieldRef?.refresh();
        if (grew) ctx.touch?.();
      })
      .catch(() => undefined);
  };

  /** Программная установка значения одиночного комбо (облачко обновится сразу). */
  let comboSetValue: ((id: string | null) => void) | null = null;

  if (!multiple) {
    const currentValue = filterValueScalarText(leaf.value);
    const combo = buildEntityCombo({
      networkId: ctx.networkId,
      kind,
      value: currentValue === '' ? null : currentValue,
      placeholder: 'выбрать…',
      ...(kind === 'thoughts' ? { thoughtPreview: true } : {}),
      ...(kind === 'thoughts' && ctx.networkId !== ''
        ? {
            // Чип-значение условия — то же облачко мысли: правый клик/
            // Shift+F10 открывают ОБЩЕЕ меню мысли (ошибка ada6a69d).
            onThoughtMenu: (value: string, anchor: HTMLElement) => {
              openFilterThoughtMenu({
                networkId: ctx.networkId,
                id: value,
                title: menuTitle(value),
                trashed: menuTrashed(value),
                anchor,
                // «Убрать из значения условия» — аналог «✕»: ячейка меняет вид
                // (заполнено → пусто), поэтому структурный путь (48f35eba).
                onRemoveFromValue: () => {
                  (api.setStructuralValue ?? api.setValue)(operandSingleValue(null));
                },
              });
            },
            onThoughtTrashBadge: (value: string) => {
              void openFilterThoughtTrashDialog(ctx.networkId, value, menuTitle(value));
            },
          }
        : {}),
      titleOf,
      ...(picker !== undefined ? { picker } : {}),
      // Токены контекста (`$thought` и пр.) — наравне с вариантами поиска
      // (ошибка 50d9bf4e п. A3): значение ссылочного операнда — id, и токен —
      // такое же значение.
      extraSources: [filterLeafTokenSource(leaf, ctx)],
      onChange: (id) => {
        api.setValue(operandSingleValue(id));
      },
      // Выбранный вариант приходит целиком — имя берём оттуда же; выбор в
      // диалоге «…» даёт только id (вариант вне каталога) — снапшот догружается
      // резолвом в `applyValueLabel`.
      onChangeEntity: (option) => {
        if (option !== null) {
          titles.set(option.id, option.title);
          if (option.cloud !== undefined) clouds.set(option.id, option.cloud);
          setLeafValueLabels(leaf, new Map([[option.id, option.title]]));
          ctx.touch?.();
          return;
        }
        applyValueLabel(currentList(leaf.value));
      },
    });
    wrap.append(combo.root);
    // Программный путь для дропа: `setValue` перерисовывает облачко значения
    // без вызова `onChange` (модель пишет приёмник) — тот же способ, что у
    // внешней перепривязки поля (задача 90b2256e).
    comboSetValue = (id) => combo.setValue(id);
    // Сохранённое значение рисуется облачком сразу, даже если каталог его не
    // знает (мысль ищется живым поиском) — догружаем данные чипа.
    fillClouds(currentList(leaf.value));
    // Команды меню меняют данные мысли — снапшот комбо пересобирается по
    // сигналу сброса ref-кэша (грабля 48f35eba).
    const comboValue = combo.value();
    watchFilterClouds({
      root: wrap,
      invalidate: (id) => {
        if (comboValue === null || (id !== null && id !== comboValue)) return;
        combo.refresh();
      },
    });
  } else {
    const options = staticEntityOptions(kind, ctx);
    const field = buildEntityChipField({
      getValues: () => currentList(leaf.value),
      onChange: (values) => {
        applyValueLabel(values);
        api.setValue(operandListValue(values));
      },
      // Токены контекста — тем же списком, что и варианты поиска (п. A3).
      extraSources: [filterLeafTokenSource(leaf, ctx)],
      loadOptions: (query) =>
        Promise.resolve(options.length > 0 ? filterEntityOptions(options, query) : thoughtsSearch(ctx, query)).then(
          rememberOptions,
        ),
      ...(options.length > 0 ? { initialOptions: options, optionsWhen: 'always' as const } : {}),
      optionsHeader: 'Значения',
      placeholder: 'Добавить значение…',
      cloudOf,
      titleOf,
      ...(kind === 'thoughts' ? { thoughtPreview: true } : {}),
      ...(kind === 'thoughts' && ctx.networkId !== ''
        ? {
            // Тот же чип-мысль, что и в одиночном значении: общее меню мысли
            // (ошибка ada6a69d) и кликабельная метка корзины.
            onThoughtMenu: (value: string, anchor: HTMLElement) => {
              openFilterThoughtMenu({
                networkId: ctx.networkId,
                id: value,
                title: menuTitle(value),
                trashed: menuTrashed(value),
                anchor,
                // «Убрать из значения условия» — прямой аналог «✕» чипа:
                // набор правят тем же путём, что и крестик.
                onRemoveFromValue: () => {
                  const next = currentList(leaf.value).filter((id) => id !== value);
                  applyValueLabel(next);
                  api.setValue(operandListValue(next));
                  fieldRef?.refresh();
                },
              });
            },
            onThoughtTrashBadge: (value: string) => {
              void openFilterThoughtTrashDialog(ctx.networkId, value, menuTitle(value));
            },
          }
        : {}),
      ...(picker !== undefined ? { picker } : {}),
    });
    fieldRef = field;
    // Каталог (типы мыслей/связей) известен заранее — запоминаем имена сразу,
    // чтобы значение, выбранное в диалоге «…», тоже получило имя без резолва.
    for (const option of options) titles.set(option.id, option.title);
    // Сохранённые значения: значок и имя чипа догружаем (живого поиска ещё не
    // было), иначе чип показывал бы голый id (ошибка f4e99090 п.5).
    fillClouds(currentList(leaf.value));
    wrap.append(field.root);
    watchFilterClouds({ root: wrap, invalidate: invalidateClouds });
  }

  // Приёмник перетаскиваемых значений (этап 3 задачи 31b228f0): совместимость
  // — общий предикат {@link filterValueAcceptsPayload}, запись — ТОТ ЖЕ путь,
  // что выбор в комбо/чип-поле (`applyValueLabel` → `api.setValue` →
  // перерисовка чипов), второго способа записи значения нет.
  const acceptEntityPayload = (payload: ThoughtDropPayload): boolean => {
    if (!filterValueAcceptsPayload(leaf, ctx, payload)) {
      notice(filterValueDropRejectionText(payload), 'warning');
      return false;
    }
    const id = payload.kind === 'thought' || payload.kind === 'type' ? payload.id : null;
    if (id === null) return false;
    const current = currentList(leaf.value);
    if (current.includes(id)) return false;
    if (!multiple) {
      applyValueLabel([id]);
      comboSetValue?.(id);
      api.setValue(operandSingleValue(id));
      return true;
    }
    const next = [...current, id];
    applyValueLabel(next);
    api.setValue(operandListValue(next));
    fieldRef?.refresh();
    return true;
  };
  api.acceptDrop = acceptEntityPayload;
  registerThoughtDropField(wrap, {
    kind: 'filter',
    accept: (id: string): boolean => acceptEntityPayload({ kind: 'thought', id }),
    acceptPayload: acceptEntityPayload,
  });

  if (hierarchyOp && !structuralOnlyHierarchy) {
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
  // Значение-ТОКЕН (`$user`) сохраняем токеном, а не строкой-id: строка «$user»
  // на сервере трактовалась бы буквальным id и условие молча ни с чем не
  // совпало бы. Значение из пикера — id участника (скаляр).
  const toValue = (id: string): FilterTreeValue =>
    id === ''
      ? { kind: 'none' }
      : id.startsWith('$')
        ? { kind: 'token', token: id }
        : { kind: 'scalar', value: id };
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
          api.setValue(toValue(id));
        },
      }),
    );
  }
  return wrap;
}
