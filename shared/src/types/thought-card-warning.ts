/**
 * Non-fatal warnings returned by mutating MCP tools (task O6,
 * docs/05-mcp-server.md §4.2). The call itself succeeds; warnings signal that
 * the resulting card is not fully compliant with its type's required-property
 * contract and the agent should follow up (typically with `etn.properties.set`
 * or another bundle that supplies the missing keys).
 *
 * The first warning code is `REQUIRED_PROPERTY_MISSING`: the thought's
 * effective property list (L21, own + inherited) declares a `required`
 * property with no stored value. The list is computed against the live
 * `property_values` table — defaults set via `config.default_value` are not
 * stored rows and therefore do NOT mask the warning (they apply only to
 * future values; the existing card still lacks a stored one).
 */

import type { PropertyValueType } from '../enums.js';

/** Stable codes for {@link ThoughtCardWarning}. New codes are additive. */
export type ThoughtCardWarningCode = 'REQUIRED_PROPERTY_MISSING';

/**
 * A single warning attached to a mutation result. Fields are picked so the
 * agent can act without an extra `etn.types.list` round-trip — `key` and
 * `value_type` are enough to call `etn.properties.set`; `defined_on` and
 * `inherited` make UI labels unambiguous when a property comes from an
 * ancestor type.
 */
export interface ThoughtCardWarning {
  code: ThoughtCardWarningCode;
  /** Property key (02-data-model.md §3.4) — addressable by `properties.set`. */
  key: string;
  /** `type_properties.id` for the definition that declared the requirement. */
  property_id: string;
  /** Id of the type that owns the property definition (own or ancestor). */
  defined_on: string;
  /** Runtime type the value must match when filling the gap. */
  value_type: PropertyValueType;
  /** `true` when the property is inherited from an ancestor type (L21). */
  inherited: boolean;
}
