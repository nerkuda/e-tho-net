/**
 * Thought types, property definitions and property values.
 *
 * Field names mirror docs/02-data-model.md §3.3–3.5 and the REST contract in
 * docs/03-server-api.md §8–9. SQLite 0/1 INTEGER columns surface as `boolean`.
 */

import type { IconKind, PropertyValueType, TypeOwnerType } from '../enums.js';

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
 * Property available on a thought/link type — row of `type_properties`
 * (02-data-model.md §3.4).
 */
export interface PropertyDefinition {
  id: string;
  owner_type: TypeOwnerType;
  /** FK to `thought_types.id` or `link_types.id` (polymorphic, no SQL FK). */
  owner_id: string;
  key: string;
  value_type: PropertyValueType;
  /**
   * JSON config. Commonly `{ allowed_type_id }` constraining the target of a
   * `thought_ref` property. Kept as an opaque map; the storage layer persists
   * it as JSON text.
   */
  config: PropertyConfig | null;
  required: boolean;
  /** Display order. */
  position: number;
  /**
   * Free-form description of the property — what it means and which format
   * its values take. Shown as a hint next to the property in the thought
   * editor and given to AI agents through `etn.types.list`.
   */
  description: string | null;
}

/** Recognised keys inside a {@link PropertyDefinition.config} JSON blob. */
export interface PropertyConfig {
  /** Default value applied to future items of the type (not `thought_ref`). */
  default_value?: string | number | boolean;
  /** For `value_type = 'thought_ref'`: restrict the referenced thought type
   *  (legacy single form; superseded by `allowed_type_ids`). */
  allowed_type_id?: string;
  /** For `value_type = 'thought_ref'`: restrict picking to thoughts of these
   *  type ids (absent/empty = any type). Stored values are never reprocessed
   *  when the filter changes. */
  allowed_type_ids?: string[];
  /** For `value_type = 'text'`: predefined values to pick from — an input aid,
   *  not a restriction: arbitrary typed values stay allowed. */
  options?: string[];
  /** For `value_type = 'text'` with `options`: allow several comma-separated
   *  values to be picked. For `value_type = 'thought_ref'`: allow several
   *  referenced thoughts — the value is an array of ids (stored as a JSON
   *  array in `value_thought_ref`, 02-data-model.md §3.4–3.5). */
  multiple?: boolean;
  /** Arbitrary extra configuration keys. */
  [key: string]: unknown;
}

/** Input accepted by `POST …/types/{id}/properties` (03-server-api.md §8). */
export interface PropertyDefinitionInput {
  key: string;
  value_type: PropertyValueType;
  config?: PropertyConfig | null;
  required?: boolean;
  position?: number;
  description?: string | null;
}

/** Input accepted by `PATCH …/types/{id}/properties/{prop_id}` (03-server-api.md §8). */
export interface PropertyDefinitionUpdateInput {
  /** Renames the key; stored values stay attached (they reference prop ids). */
  key?: string;
  value_type?: PropertyValueType;
  config?: PropertyConfig | null;
  required?: boolean;
  position?: number;
  description?: string | null;
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
}

/** Body of `PUT …/types/{id}/properties/{prop_id}/default` (03-server-api.md §8). */
export interface PropertyDefaultOverrideInput {
  /** Default value to override with; `null` clears the override (inherits). */
  value: PropertyValueValue;
}

/**
 * Union of all value payloads that may be stored against a property. Exactly
 * one of the storage columns (`value_text`/`value_date`/`value_number`/
 * `value_bool`/`value_thought_ref`) is populated; the API exposes a single
 * `value` field whose runtime type matches {@link PropertyValueType}.
 *
 * `string[]` is the multiple form of a `thought_ref` property (definitions
 * with `config.multiple = true`): an array of thought ids, stored as a JSON
 * array inside `value_thought_ref` (02-data-model.md §3.5).
 */
export type PropertyValueValue = string | number | boolean | string[] | null;

/** A stored property value — polymorphic EAV (02-data-model.md §3.5). */
export interface PropertyValue {
  id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
  property_id: string;
  /** Value whose runtime type matches the definition's `value_type`. */
  value: PropertyValueValue;
  updated_at: string;
}

/** `thought_ref`-значение в MCP-чтении (task N4): ссылка на мысль,
 * резолвнутая в `{id, title}` одним JOIN. `title: null` — висячая ссылка
 * (мысль удалена; `value_thought_ref` без SQL FK). */
export interface ResolvedThoughtRefValue {
  id: string;
  title: string | null;
}

/** PropertyValue MCP-чтения (task N4): `thought_ref`-значения резолвнуты
 * в {@link ResolvedThoughtRefValue} (одиночные) либо в массив
 * {@link ResolvedThoughtRefValue} (множественные, `config.multiple`);
 * REST-контракт не меняется. */
export interface ResolvedPropertyValue extends Omit<PropertyValue, 'value'> {
  value: PropertyValueValue | ResolvedThoughtRefValue | ResolvedThoughtRefValue[];
}

/** Body of `PUT …/{id}/properties/{key}` (03-server-api.md §9). */
export interface PropertyValueInput {
  value: PropertyValueValue;
}
