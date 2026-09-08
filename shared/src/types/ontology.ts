/**
 * `etn.ontology.*` MCP tools (задача cc9ca65e, версия 0.7.2).
 *
 * Управление онтологией сети (типы мыслей, типы связей, реестр свойств,
 * привязки свойств к типам) из MCP одной транзакцией. Два инструмента:
 *
 *   * `etn.ontology.write` — идемпотентный upsert пакетами
 *     `thought_types[]` / `link_types[]` / `properties[]` / `type_properties[]`.
 *     Поддерживает локальные `ref` для адресации внутри батча
 *     (`parent_ref`, `type_ref`, `property_ref`).
 *   * `etn.ontology.delete` — деструктивное удаление одной сущности;
 *     без `force` отвергается на используемых элементах со счётчиками в
 *     `details`.
 *
 * Имена инструментов и аннотации (`MCP_TOOL_NAMES` / `MCP_TOOL_ANNOTATIONS`)
 * живут в `./mcp.ts`; здесь только payload-типы.
 */

import type { IconKind, LinkStyle, PropertyValueType, TypeOwnerType } from '../enums.js';
import type { PropertyConfig } from './thought-type.js';

// ===========================================================================
// `etn.ontology.write`
// ===========================================================================

/**
 * Один элемент `thought_types[]` в `etn.ontology.write` (задача cc9ca65e).
 *
 * Upsert по `id` XOR `name`:
 *   * `id` задан → патч существующего типа;
 *   * `name` задан и не совпадает ни с одним типом → создание;
 *   * `name` совпало с несколькими типами → `VALIDATION_ERROR` с
 *     `details.candidates`;
 *   * ни `id`, ни `name` не заданы → `VALIDATION_ERROR`.
 *
 * `parent` / `parent_ref` — XOR. `parent_ref` действует только внутри
 * батча и адресует другой элемент `thought_types[]` по его `ref`.
 */
export interface OntologyWriteThoughtType {
  /** Локальное имя в пределах батча (аналог `ref` в `etn.thoughts.write`).
   *  Должно быть уникальным внутри `thought_types[]`. Используется другими
   *  элементами через `parent_ref`. */
  ref?: string;
  /** Существующий id типа для патча. XOR с `name` (см. описание). */
  id?: string | null;
  /** Имя типа. Создание при отсутствии совпадений, патч при одном совпадении. */
  name?: string;
  /** Родительский тип по id. `null` — прикрепить прямо под корень. */
  parent?: string | null;
  /** Роковое имя родительского типа из этого же батча. */
  parent_ref?: string | null;
  description?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
  /** Шаблон постоянного комментария мысли (см. {@link ThoughtType.comment_template_md}). */
  comment_template_md?: string | null;
}

/**
 * Один элемент `link_types[]` в `etn.ontology.write`.
 *
 * Upsert по `id` XOR `(name_forward, name_reverse)`. Пара имён уникальна
 * по сети (L21). Смена `name_forward` / `name_reverse` требует явного
 * patch-режима (т.е. задан `id`); при создании оба имени обязательны.
 */
export interface OntologyWriteLinkType {
  /** Локальное имя в пределах батча. */
  ref?: string;
  id?: string | null;
  name_forward?: string;
  name_reverse?: string;
  parent?: string | null;
  parent_ref?: string | null;
  color?: string | null;
  style?: LinkStyle | null;
  width?: number | null;
  description?: string | null;
}

/**
 * Один элемент `properties[]` в `etn.ontology.write` — свойство реестра
 * (network-wide). Upsert по `id` XOR `name`. Смена `value_type` использует
 * ту же доменную функцию конверсии, что `PATCH /properties/{id}`; ответ
 * несёт `converted_values` / `dropped_values` по этому свойству.
 */
export interface OntologyWriteProperty {
  /** Локальное имя в пределах батча. Используется элементами
   *  `type_properties[]` через `property_ref`. */
  ref?: string;
  id?: string | null;
  name?: string;
  value_type?: PropertyValueType;
  config?: PropertyConfig | null;
  description?: string | null;
}

/**
 * Один элемент `type_properties[]` — подключение свойства к типу
 * (привязка). Свойство и подключение — разные сущности; инструмент
 * фиксирует это разделение (одна запись в `properties[]`, другая в
 * `type_properties[]`).
 *
 * `type` / `type_ref` — XOR. `property` / `property_ref` — XOR.
 */
export interface OntologyWriteTypeProperty {
  /** Вид владельца привязки: `thought_type` или `link_type`. */
  owner: TypeOwnerType;
  /** Имя типа-владельца (case-insensitive). */
  type?: string;
  /** Локальное имя типа из этого же батча (`thought_types[].ref` или
   *  `link_types[].ref`). */
  type_ref?: string;
  /** Имя свойства из реестра. */
  property?: string;
  /** Локальное имя свойства из этого же батча (`properties[].ref`). */
  property_ref?: string;
  required?: boolean;
  /** Позиция в списке свойств типа; по умолчанию — после текущего максимума. */
  position?: number;
  /** Значение по умолчанию, пишется как override в `config.default_value`. */
  default_value?: unknown;
}

/**
 * Один элемент `type_views[]` в `etn.ontology.write` (задача c1fa71d4, 0.7.3,
 * ADR 5c44f6a7 «Отборы правятся инструментами онтологии»). Создание,
 * правка и удаление отборов типов идут той же транзакцией, что и сами
 * типы, — без отдельного семейства `etn.views.*` на запись.
 *
 * Действие `action`:
 *   * `create` — `thought_type_id` (или `thought_type_ref` из этого же
 *     батча) + `name` обязательны; `definition` обязателен. Upsert:
 *     если у указанного типа уже есть отбор с тем же `name_key`, обновит
 *     его (как `update`).
 *   * `update` — требуется `id` существующего отбора (или `ref_for_update`,
 *     если был создан в этом же батче под `ref`); меняются только
 *     переданные поля.
 *   * `delete` — требуется `id` существующего отбора (или `ref_for_update`
 *     из этого же батча). В этом случае остальные поля игнорируются.
 *
 * `thought_type` / `thought_type_ref` — XOR. `definition` обязан быть
 * валидной JSON-строкой того же формата, что и `saved_filters.definition`
 * (требование 141c2576, 7263e565, eaca1253, 3697eb65 — те же, что и для
 * REST `POST /thought-types/{id}/views`).
 */
export interface OntologyWriteTypeView {
  /** Локальное имя в пределах батча. Используется для адресации из этого
   *  же батча через `ref_for_update` других элементов `type_views[]`. */
  ref?: string;
  /** Действие: создание (upsert), правка или удаление. */
  action: 'create' | 'update' | 'delete';
  /** Id существующего отбора для `update` / `delete`. */
  id?: string;
  /** Локальный `ref` другого элемента `type_views[]` из этого же батча,
   *  адресующий только что созданный/обновлённый отбор. */
  ref_for_update?: string;
  /** Id существующего типа-владельца (XOR с `thought_type_ref`). */
  thought_type?: string;
  /** Локальный `ref` типа из `thought_types[]` этого же батча (XOR с
   *  `thought_type`). */
  thought_type_ref?: string;
  /** Видимое имя (1..200 символов, trim+lowercase для сравнения). */
  name?: string;
  /** Описание отбора (≤1000 символов). `null` снимает описание. */
  description?: string | null;
  /** JSON-строка определения отбора (`SavedFilterDefinition`). */
  definition?: string;
  /** Позиция в списке отборов типа. */
  position?: number;
  /** `true` — отбор открывается сам при переводе мысли в фокус. */
  is_default?: boolean;
}

/** Действие, выполненное над одним элементом `thought_types[]`. */
export type OntologyWriteThoughtTypeAction = 'created' | 'updated' | 'unchanged';

/** Действие, выполненное над одним элементом `link_types[]`. */
export type OntologyWriteLinkTypeAction = 'created' | 'updated' | 'unchanged';

/** Действие, выполненное над одним элементом `properties[]` (плюс счётчики
 *  конверсии `value_type`, если менялся тип). */
export type OntologyWritePropertyAction = 'created' | 'updated' | 'unchanged';

/** Действие, выполненное над одним элементом `type_properties[]`. */
export type OntologyWriteTypePropertyAction = 'created' | 'updated' | 'unchanged';

/** Действие, выполненное над одним элементом `type_views[]`. */
export type OntologyWriteTypeViewAction = 'created' | 'updated' | 'deleted' | 'unchanged';

/** Результат одного элемента `thought_types[]`. */
export interface OntologyWriteThoughtTypeResult {
  /** Локальный `ref` из запроса (для диагностики). */
  ref: string | null;
  /** Resolved id типа (после create или patch). */
  id: string;
  version: number;
  action: OntologyWriteThoughtTypeAction;
}

/** Результат одного элемента `link_types[]`. */
export interface OntologyWriteLinkTypeResult {
  ref: string | null;
  id: string;
  version: number;
  action: OntologyWriteLinkTypeAction;
}

/** Результат одного элемента `properties[]`. */
export interface OntologyWritePropertyResult {
  ref: string | null;
  id: string;
  version: number;
  action: OntologyWritePropertyAction;
  /** Число конвертированных значений при смене `value_type`. `0`, если тип
   *  не менялся или у свойства нет сохранённых значений. */
  converted_values: number;
  /** Число сброшенных значений при смене `value_type`. */
  dropped_values: number;
}

/** Результат одного элемента `type_properties[]`. */
export interface OntologyWriteTypePropertyResult {
  /** `(owner_type, owner_id, property_id)` — natural key привязки. */
  owner: TypeOwnerType;
  /** `type_ref` из запроса или `null`, если тип был адресован по `type`. */
  type_ref: string | null;
  /** `property_ref` из запроса или `null`, если свойство было адресован
   *  по `property`. */
  property_ref: string | null;
  /** Resolved id типа-владельца. */
  type_id: string;
  /** Resolved id свойства. */
  property_id: string;
  /** Id созданной/обновлённой привязки (`type_properties.id`). */
  id: string;
  version: number;
  action: OntologyWriteTypePropertyAction;
}

/**
 * Результат одного элемента `type_views[]` (задача c1fa71d4, 0.7.3).
 * `id` и `version` возвращаются для созданных/обновлённых/удалённых; для
 * `unchanged` (повторный upsert с теми же аргументами) совпадают с БД.
 */
export interface OntologyWriteTypeViewResult {
  /** `ref` из запроса или `null`, если адресация шла по `id`. */
  ref: string | null;
  /** Id отбора в `thought_type_views` (после create/update или до delete). */
  id: string;
  /** Resolved id типа-владельца. */
  thought_type_id: string;
  version: number;
  action: OntologyWriteTypeViewAction;
}

/** Параметры `etn.ontology.write`. */
export interface OntologyWriteParams {
  network_id: string;
  thought_types?: OntologyWriteThoughtType[];
  link_types?: OntologyWriteLinkType[];
  properties?: OntologyWriteProperty[];
  type_properties?: OntologyWriteTypeProperty[];
  /**
   * Отборы типов мыслей (задача c1fa71d4, 0.7.3). Upsert/delete в одной
   * транзакции с типами и свойствами. Локальные `ref` действуют внутри
   * батча; `thought_type_ref` позволяет привязать отбор к типу,
   * создаваемому в этом же батче.
   */
  type_views?: OntologyWriteTypeView[];
}

/** Результат `etn.ontology.write`. */
export interface OntologyWriteResult {
  thought_types: OntologyWriteThoughtTypeResult[];
  link_types: OntologyWriteLinkTypeResult[];
  properties: OntologyWritePropertyResult[];
  type_properties: OntologyWriteTypePropertyResult[];
  type_views: OntologyWriteTypeViewResult[];
  /** Слой сессии, в котором материализовался батч. */
  layer: { id: string; title: string };
  request_id?: string;
}

// ===========================================================================
// `etn.ontology.delete`
// ===========================================================================

/** Вид удаляемой сущности в `etn.ontology.delete`. */
export type OntologyDeleteKind =
  | 'thought_type'
  | 'link_type'
  | 'property'
  | 'type_property'
  // `type_view` (задача c1fa71d4, 0.7.3) — отбор типа мысли. Без `force`
  // удаляется безусловно (отбор не имеет входящих зависимостей кроме
  // владеющего типа, который остаётся). Удаление типа с `force` каскадно
  // удаляет и его отборы.
  | 'type_view';

/** Параметры `etn.ontology.delete`. Без `force` используемый элемент
 *  отвергается со счётчиками в `details`. С `force` — каскад по правилам:
 *
 *   * `thought_type` — обнуляет `type_id` связанных мыслей, каскад на
 *     `type_properties` этого типа;
 *   * `link_type` — каскад на связи этого типа (связи удаляются вместе с
 *     их свойствами и комментариями);
 *   * `property` — каскад на `property_values` и `type_properties` этого
 *     свойства;
 *   * `type_property` — удаляется только строка привязки.
 *
 *  Элемент, занятый в `type_roles` сети, отвергается даже с `force` —
 *  сначала снять роль через `etn.networks.write`. */
export interface OntologyDeleteParams {
  network_id: string;
  kind: OntologyDeleteKind;
  id: string;
  force?: boolean;
}

/** Счётчики влияния удаления, по виду сущности. */
export interface OntologyDeleteAffectedCounts {
  /** Для `thought_type` / `link_type` — число мыслей/связей, у которых
   *  обнулился `type_id` (или которые были удалены каскадом). */
  thoughts_count?: number;
  links_count?: number;
  /** Для `property` — число сброшенных `property_values`. */
  property_values_count?: number;
  /** Число привязок `type_properties`, удалённых каскадом. */
  type_properties_count?: number;
  /** Для `thought_type` (с `force=true`) — число отборов, удалённых
   *  каскадом вместе с типом (задача c1fa71d4, 0.7.3). */
  type_views_count?: number;
}

/** Результат `etn.ontology.delete`. */
export interface OntologyDeleteResult {
  deleted: true;
  /** Счётчики влияния по правилам каскада. */
  affected_counts: OntologyDeleteAffectedCounts;
  request_id?: string;
}
