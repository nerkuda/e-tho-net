/**
 * Thought types, property definitions and property values.
 *
 * Field names mirror docs/02-data-model.md §3.3–3.5 and the REST contract in
 * docs/03-server-api.md §8–9. SQLite 0/1 INTEGER columns surface as `boolean`.
 */

import type { IconKind, LinkPropertySide, LinkStyle, PropertyValueType, TypeOwnerType } from '../enums.js';

/** User-defined thought type (02-data-model.md §3.3). */
export interface ThoughtType {
  id: string;
  name: string;
  /** Parent type id; `null` only on the root type («основной тип»). */
  parent_id: string | null;
  /** True for the single undeletable root of the type tree. */
  is_root: boolean;
  icon: string | null;
  /** Kind of the default icon (thoughts without their own icon inherit it). */
  icon_kind: IconKind;
  fg_color: string | null;
  bg_color: string | null;
  /**
   * Default font styles. `null` — not set on this type: the parent type's
   * value applies (the root falls back to the application defaults, L21).
   */
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  /** Free-form description used to give AI agents context about the type. */
  description: string | null;
  /**
   * Шаблон постоянного комментария мысли (02-data-model.md §3.3). Клиент
   * применяет его при создании мысли с этим типом или при назначении/смене
   * типа у существующей мысли — только если постоянного комментария ещё нет
   * (08-ui-spec.md §8.1).
   */
  comment_template_md: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  /**
   * Id пользователя, последним изменившего тип (требование e6d4165e). Колонка
   * `updated_by` физически добавлена миграцией 033. Сервер всегда возвращает;
   * помечено `?` чтобы клиентские фикстуры могли собирать объект без него.
   */
  updated_by?: string;
  /** Unix-миллисекунды `created_at` (для сортировки). */
  created_at_ms?: number;
  /** Unix-миллисекунды `updated_at`. */
  updated_at_ms?: number;
}

/** Input accepted by `POST /thought-types` (03-server-api.md §8). */
export interface ThoughtTypeInput {
  name: string;
  /** Parent type; `null`/omitted — attach directly under the root type. */
  parent_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
  description?: string | null;
  /** Шаблон постоянного комментария мысли (см. {@link ThoughtType.comment_template_md}). */
  comment_template_md?: string | null;
}

/** Input accepted by `PATCH /thought-types/{id}` (03-server-api.md §8). */
export interface ThoughtTypeUpdateInput {
  name?: string;
  /** Changing the parent is rejected while the type is in use by thoughts. */
  parent_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
  description?: string | null;
  /** Шаблон постоянного комментария мысли (см. {@link ThoughtType.comment_template_md}). */
  comment_template_md?: string | null;
}

/**
 * A property available on a thought/link type — row of `type_properties`
 * (02-data-model.md §3.4). Since 0.6.5 `type_properties` is a **binding** of a
 * network-wide registry property (`properties`) to a type: the binding carries
 * only the property's role in this type (`required`, `position`), while its
 * nature (name, value type, config, description) lives in the registry and is
 * merged into this shape for API compatibility.
 */
export interface PropertyDefinition {
  /** Binding id (`type_properties.id`). */
  id: string;
  /** Registry property id (`properties.id`) — the nature this binding attaches. */
  property_id: string;
  owner_type: TypeOwnerType;
  /** FK to `thought_types.id` or `link_types.id` (polymorphic, no SQL FK). */
  owner_id: string;
  /** Property name (registry `properties.name`), unique per network. */
  key: string;
  value_type: PropertyValueType;
  /**
   * JSON config of the property's value type (e.g. `options` for `text`,
   * `link_type_id`/`direction` для свойства-связи). Kept as an opaque map;
   * the storage layer persists it as JSON text.
   */
  config: PropertyConfig | null;
  required: boolean;
  /** Display order. */
  position: number;
  /**
   * Сторона привязки (0.8.1, задача e1fbf304; требование b9562306): для
   * свойств-связей — `source` / `target` (направление в привязке), для
   * скалярных и структурных свойств — `undefined`. Хранится в колонке
   * `type_properties.side`; для миграционной совместимости выводится из
   * `config.direction`, если сторона не указана явно.
   */
  side?: LinkPropertySide | null;
  /**
   * Free-form description of the property — what it means and which format
   * its values take. Shown as a hint next to the property in the thought
   * editor and given to AI agents through `etn.types.list`.
   */
  description: string | null;
  /**
   * `true` для зеркального свойства-связи (требование dde92461): свойство не
   * привязано к типу явно — оно синтезируется при чтении из чужого
   * свойства-связи, чей `allowed_target_type_ids` покрывает этот тип. У
   * физических привязок `type_properties` флаг отсутствует (`undefined`);
   * направление зеркала противоположно направлению исходного свойства.
   */
  mirrored?: boolean;
}

/** A network-wide property of the `properties` registry (02-data-model.md §3.4a). */
export interface NetworkProperty {
  id: string;
  /** User-visible name; unique per network (case-insensitive, by `name_key`). */
  name: string;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  /** Id пользователя, создавшего свойство (требование e6d4165e). Сервер
   *  всегда возвращает; помечено `?` чтобы клиентские фикстуры могли
   *  собирать объект без него. */
  created_by?: string;
  /** Id пользователя, последним изменившего свойство. */
  updated_by?: string;
  /** Unix-миллисекунды `created_at` (для сортировки). */
  created_at_ms?: number;
  /** Unix-миллисекунды `updated_at`. */
  updated_at_ms?: number;
}

/** Input accepted by the registry create (REST wiring lands after 0.6.5 domain). */
export interface NetworkPropertyInput {
  name: string;
  value_type: PropertyValueType;
  config?: PropertyConfig | null;
  description?: string | null;
  /**
   * Пара имён нового типа связи (0.8.1, требование 09f692ff: создание
   * свойства-связи создаёт тип связи). Если задано для `value_type = 'link'` —
   * сервер создаёт link_type автоматически и записывает его id в
   * `config.link_type_id`. Для скалярных свойств игнорируется.
   */
  name_forward?: string;
  name_reverse?: string;
  /**
   * Опциональные атрибуты оформления нового типа связи (0.8.1).
   */
  parent_link_type_id?: string | null;
  link_color?: string | null;
  link_style?: LinkStyle | null;
  link_width?: number | null;
}

/** Input accepted by the registry update. `value_type` converts stored values. */
export interface NetworkPropertyUpdateInput {
  name?: string;
  value_type?: PropertyValueType;
  config?: PropertyConfig | null;
  description?: string | null;
  /**
   * Новое прямое имя типа связи (0.8.1): правка свойства-связи правит
   * связанный link_type. Для скалярных и структурных свойств игнорируется.
   */
  name_forward?: string;
  /**
   * Новое обратное имя типа связи (0.8.1). См. {@link name_forward}.
   */
  name_reverse?: string;
  /** Опциональные атрибуты оформления (0.8.1). */
  link_color?: string | null;
  link_style?: LinkStyle | null;
  link_width?: number | null;
}

/** Recognised keys inside a {@link PropertyDefinition.config} JSON blob. */
export interface PropertyConfig {
  /**
   * Default value applied to future items of the type. Scalar kinds use
   * string/number/boolean; a link property uses `string[]` — the default set
   * of target thought ids, applied by creating edges (0.8.1, bb67e546).
   */
  default_value?: string | number | boolean | string[];
  /**
   * For `value_type = 'link'`: тип связи, обязательный. Проекция —
   * рёбра этого типа.
   */
  link_type_id?: string;
  /**
   * For `value_type = 'link'`: структурное (нетипизированное) свойство-связь —
   * проецирует нетипизированные рёбра (`type_id IS NULL`). Взаимоисключающе с
   * `link_type_id`: у структурного свойства типа связи нет, имя хранится в
   * реестре («Родители»/«Потомки»), а не вычисляется из типа связи.
   */
  structural?: boolean;
  /**
   * For `value_type = 'link'`: направление от владельца свойства — `out`
   * (владелец — источник ребра, имя `name_forward`) или `in` (владелец —
   * цель, имя `name_reverse`). По умолчанию `out`.
   */
  direction?: 'out' | 'in';
  /**
   * For `value_type = 'link'`: опциональное ограничение типов
   * противоположной стороны; раскрывается до поддеревьев типов. При
   * заполнении у допустимых типов появляется зеркальное обратное свойство.
   */
  allowed_target_type_ids?: string[];
  /**
   * For `value_type = 'link'`: симметричное ограничение типов источника
   * (0.8.1, задача d7177d1d) — для привязок со стороны назначения
   * (`side = 'target'`). При заполнении у допустимых источников появляется
   * встречное свойство. `null`/`[]` — снять ограничение.
   */
  allowed_source_type_ids?: string[];
  /** For `value_type = 'link'`: рисовать ли связь на карте по умолчанию
   *  (по умолчанию `false`). */
  show_on_map?: boolean;
  /** For `value_type = 'link'`: блокирует ли ссылка физическое удаление
   *  цели (по умолчанию `false`). */
  blocks_target_deletion?: boolean;
  /** For `value_type = 'text'`: predefined values to pick from — an input aid,
   *  not a restriction: arbitrary typed values stay allowed. */
  options?: string[];
  /** Allow several values.
   *
   *   * `value_type = 'text'` with `options` — a comma-separated list of
   *     predefined values may be picked; the stored shape is a single string,
   *     not an array.
   *   * `value_type = 'link'` — набор целей не ограничен (сколько рёбер типа
   *     существует, столько и значений); флаг сохранён миграцией 040 из
   *     бывшего `thought_ref`.
   *   * `value_type = 'url'` — an array of URL/file-path strings; the value is
   *     stored as a JSON array in `value_text` (02-data-model.md §3.4–3.5). A
   *     JSON-array payload is used (not comma-join as for `text`) because URLs
   *     may contain commas — a comma-joined text would be ambiguous to parse
   *     back. (task 0.6.2)
   */
  multiple?: boolean;
  /** Arbitrary extra configuration keys. */
  [key: string]: unknown;
}

/** Input accepted by `POST …/types/{id}/properties` (03-server-api.md §8):
 *  create a brand-new registry property in this layer and attach it. The
 *  server's `property_id` form lives in {@link AttachPropertyInput}. */
export interface PropertyDefinitionInput {
  key: string;
  value_type: PropertyValueType;
  config?: PropertyConfig | null;
  required?: boolean;
  position?: number;
  description?: string | null;
  /** Сторона привязки для свойства-связи (0.8.1). Если не задана — выводится
   *  из `config.direction` (fallback для совместимости со старыми вызовами). */
  side?: LinkPropertySide | null;
}

/**
 * Discriminated union of the two `POST …/types/{id}/properties` shapes
 * (0.6.5, task 75404197):
 *  - `attach` — bind an existing registry property by id;
 *  - `create` — create the registry property in this layer and bind it.
 *
 * `required`/`position` are part of the binding and apply to both shapes.
 */
export type AttachPropertyInput =
  | {
      mode: 'attach';
      property_id: string;
      required?: boolean;
      position?: number;
      /** Сторона привязки для свойства-связи (0.8.1). */
      side?: LinkPropertySide | null;
    }
  | {
      mode: 'create';
      key: string;
      value_type: PropertyValueType;
      config?: PropertyConfig | null;
      description?: string | null;
      required?: boolean;
      position?: number;
      /** Сторона привязки для свойства-связи (0.8.1). */
      side?: LinkPropertySide | null;
    };

/** Input accepted by `PATCH …/types/{id}/properties/{prop_id}` (03-server-api.md §8). */
export interface PropertyDefinitionUpdateInput {
  /** Renames the key; stored values stay attached (they reference prop ids). */
  key?: string;
  value_type?: PropertyValueType;
  config?: PropertyConfig | null;
  required?: boolean;
  position?: number;
  description?: string | null;
  /** Сторона привязки для свойства-связи (0.8.1). */
  side?: LinkPropertySide | null;
}

/**
 * A property definition resolved over a type's ancestor chain (L21,
 * 02-data-model.md §3.4.1): the type's own properties plus everything
 * inherited from its parents. `default_value` is the effective default — the
 * deepest ancestor override, else the definition's own `config.default_value`.
 */
export interface EffectiveTypeProperty extends PropertyDefinition {
  /** `false` — defined on this very type; `true` — inherited from an ancestor. */
  inherited: boolean;
  /** Id of the type the definition belongs to (`owner_id` mirror, for convenience). */
  defined_on: string;
  /** Name of the type the definition belongs to (UI labels). */
  defined_on_name: string;
  /** Effective default value (override-aware); `null` — no default. */
  default_value: PropertyValueValue;
  /** This type overrides the inherited default (`type_property_overrides`). */
  overridden_here: boolean;
  /**
   * The inherited `description` (from {@link PropertyDefinition}) is
   * override-aware: the description override stored on this type, else the
   * definition's own. This flag tells the two apart.
   */
  description_overridden: boolean;
  /** `true` — зеркальное свойство-связь (см. {@link PropertyDefinition.mirrored}). */
  mirrored?: boolean;
  /** Сторона привязки (0.8.1): пробрасывается из `type_properties.side`
   *  физической строки либо из зеркала. См. {@link PropertyDefinition.side}. */
  side?: LinkPropertySide | null;
}

/** Body of `PUT …/types/{id}/properties/{prop_id}/default` (03-server-api.md §8). */
export interface PropertyDefaultOverrideInput {
  /** Default value to override with; `null` clears the override (inherits). */
  value: PropertyValueValue;
}

/**
 * Union of all value payloads that may be stored against a property. Exactly
 * one of the storage columns (`value_text`/`value_date`/`value_number`/
 * `value_bool`) is populated; the API exposes a single `value` field whose
 * runtime type matches {@link PropertyValueType}. Свойство-связь (`link`)
 * значений в `property_values` не хранит — его значение читается из рёбер
 * (ADR «свойство-связь — проекция ребра»).
 *
 * `string[]` is the multiple form of `url` (definitions with
 * `config.multiple = true`, 02-data-model.md §3.4–3.5): an array of
 * URL/file-path strings, stored as a JSON array inside `value_text`
 * (task 0.6.2). A JSON-array payload is used (not comma-join as for `text`)
 * because URLs may contain commas.
 */
export type PropertyValueValue = string | number | boolean | string[] | null;

/**
 * Резолвнутая форма legacy `thought_ref` для MCP-чтения (задача N4, миграция
 * 040): одиночный id → `{id, title}`, JSON-массив id → массив таких же.
 * `title: null` означает висячую ссылку на удалённую мысль. Используется
 * только в {@link ResolvedPropertyValue.value}; EAV-форма {@link PropertyValueValue}
 * остаётся прежней (запись идёт строкой/JSON-массивом в `value_thought_ref`).
 */
export type ResolvedThoughtRefValue =
  | { id: string; title: string | null }
  | Array<{ id: string; title: string | null }>;

/** A stored property value — polymorphic EAV (02-data-model.md §3.5). */
export interface PropertyValue {
  id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
  property_id: string;
  /**
   * `true` when the property is not attached to the owner's type (neither by
   * the type's own binding nor by any ancestor's) — a value left over from a
   * type change or a detached property. Such values are read-only history:
   * they can only be deleted, never written (02-data-model.md §3.5a).
   */
  outside_type: boolean;
  /** Property name from the registry — needed to render an outside-type value. */
  property_name: string;
  /** Property value type from the registry. */
  value_type: PropertyValueType;
  /** Value whose runtime type matches the definition's `value_type`. */
  value: PropertyValueValue;
  updated_at: string;
  /**
   * Id пользователя, создавшего значение (требование e6d4165e; колонка
   * `created_by` физически добавлена миграцией 033). Сервер всегда возвращает;
   * помечено `?` чтобы клиентские фикстуры могли собирать объект без него.
   */
  created_by?: string;
  /** Id пользователя, последним изменившего значение. */
  updated_by?: string;
  /** Unix-миллисекунды создания (для сортировки). */
  created_at_ms?: number;
  /** Unix-миллисекунды `updated_at`. */
  updated_at_ms?: number;
}

/**
 * PropertyValue MCP-чтения (task N4): форма совпадает с {@link PropertyValue},
 * но `value` для legacy `thought_ref` расширен до {@link ResolvedThoughtRefValue}
 * — агенту не нужны отдельные вызовы `etn.thoughts.get` на каждую ссылку.
 * Тип сохранён как элемент союза со {@link ResolvedLinkProperty} в карточке мысли.
 */
export interface ResolvedPropertyValue extends Omit<PropertyValue, 'value'> {
  value: PropertyValue['value'] | ResolvedThoughtRefValue;
}

/**
 * Одно значение свойства-связи — живое ребро `links` (0.8.1). Возвращается
 * запросом значений свойства-связи (REST `GET …/properties`); карточка мысли
 * вместо списка отдаёт счётчик {@link ResolvedLinkProperty.count}.
 */
export interface LinkPropertyValueItem {
  /** Id ребра — адрес для `etn.links.get` и операций записи связи. */
  link_id: string;
  /** Id цели (противоположный конец ребра от владельца свойства). */
  target_id: string;
  /** Заголовок цели; `null` — цель удалена. */
  target_title: string | null;
  /** Тип цели; `null` — без типа. */
  target_type_id: string | null;
  /** Полный текст постоянного комментария ребра; `null` — комментария нет. */
  comment: string | null;
}

/**
 * Свойство-связь в карточке мысли (0.8.1): связи отдаются счётчиком
 * {@link count}, а не списком целей. Скаляры — значениями, связи — счётчиками.
 * Полный список рёбер — отдельным запросом значений ({@link LinkPropertyValues}).
 */
export interface ResolvedLinkProperty {
  /** Id свойства реестра. */
  id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
  property_id: string;
  /**
   * `true`, когда свойство не подключено к типу владельца: внетиповое
   * свойство-связь либо зеркало без ограничения типа цели.
   */
  outside_type: boolean;
  /** Имя свойства, вычисленное из типа связи по направлению (не хранится). */
  property_name: string;
  value_type: 'link';
  /** Направление от владельца: `out` — владелец источник, `in` — цель. */
  direction: 'out' | 'in';
  /** Сторона привязки (0.8.1): `source` для типа-источника, `target` для
   *  типа-назначения; `undefined` для структурного свойства или когда
   *  сторона не вычислена. */
  side?: LinkPropertySide | null;
  /** Id типа связи; `null` — структурное (нетипизированное) свойство-связь. */
  link_type_id: string | null;
  /** `true` — структурное свойство-связь (нетипизированные рёбра). */
  structural: boolean;
  /** Счётчик живых рёбер, проецируемых в это свойство. */
  count: number;
  /** Собственное описание свойства (уточняет применение для типа). */
  description?: string | null;
}

/**
 * Значения свойства-связи в ответе на запрос значений (REST
 * `GET …/properties`, 0.8.1): список живых рёбер {@link LinkPropertyValueItem}
 * плюс счётчик. Отличается от {@link ResolvedLinkProperty} наличием `values`.
 */
export interface LinkPropertyValues extends ResolvedLinkProperty {
  /** Рёбра в порядке убывания новизны. */
  values: LinkPropertyValueItem[];
}

/** Body of `PUT …/{id}/properties/{key}` (03-server-api.md §9). */
export interface PropertyValueInput {
  value: PropertyValueValue;
}
