/**
 * Staged (draft) editing of a type's OWN property definitions (task
 * «Улучшить диалог редактирования типов мыслей и связей»).
 *
 * The type editor no longer writes each property change straight to the
 * server: every add/edit/reorder/delete of an own property mutates a local
 * `DraftProperty[]` array, and the whole set is reconciled with the server
 * only when the user presses «Применить и закрыть». {@link planPropertyDiff}
 * is the pure part of that reconciliation — pulled out of the DOM-heavy
 * dialog code so the (non-trivial) diff logic is unit-testable without a
 * network or a document.
 */

import type {
  PropertyConfig,
  PropertyDefinition,
  PropertyDefinitionInput,
  PropertyDefinitionUpdateInput,
  PropertyValueType,
} from '@etn/shared';

/**
 * One row of the staged own-properties table: either a definition already
 * persisted on the server (`isNew: false`, `id` is the real server id) or one
 * added during this editing session and not yet created (`isNew: true`, `id`
 * is a local placeholder from {@link nextDraftPropertyId} — never sent to the
 * server as-is).
 */
export interface DraftProperty {
  id: string;
  isNew: boolean;
  key: string;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
}

let draftCounter = 0;

/** A fresh placeholder id for a newly staged (not yet created) property. */
export function nextDraftPropertyId(): string {
  draftCounter += 1;
  return `draft:${draftCounter}`;
}

/** Builds the initial staged list from a type's own (non-inherited)
 *  definitions, ordered as the server returns them (`position`, then `key`). */
export function draftPropertiesFrom(own: readonly PropertyDefinition[]): DraftProperty[] {
  return own.map((d) => ({ id: d.id, isNew: false, key: d.key, value_type: d.value_type, config: d.config }));
}

/** Deep-ish equality of two property configs (both may be `null`). */
function configEqual(a: PropertyConfig | null, b: PropertyConfig | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** One step of the Apply-time reconciliation plan (see {@link planPropertyDiff}). */
export type PropertyDiffOp =
  | { kind: 'delete'; id: string }
  | { kind: 'create'; draftId: string; input: PropertyDefinitionInput }
  | { kind: 'update'; id: string; changes: PropertyDefinitionUpdateInput };

/** Result of {@link planPropertyDiff}. */
export interface PropertyDiffPlan {
  ops: PropertyDiffOp[];
  /** Whether a final `reorderTypeProperties` call is needed once every
   *  create/update above has run (covers reordering AND new rows landing in
   *  the middle of the list — a single reorder after the creates is simpler
   *  and just as correct as tracking `position` per op). */
  needsReorder: boolean;
}

/**
 * Computes the Apply-time plan for a type's staged own properties: deletes
 * first (so a freed key never collides with a rename in the same batch),
 * then create/update ops in the drafted order. Pure — no network, no DOM.
 */
export function planPropertyDiff(
  original: readonly PropertyDefinition[],
  draft: readonly DraftProperty[],
  deletedIds: readonly string[],
): PropertyDiffPlan {
  const originalById = new Map(original.map((d) => [d.id, d]));
  const ops: PropertyDiffOp[] = [];
  for (const id of deletedIds) ops.push({ kind: 'delete', id });
  let anyNew = false;
  for (const d of draft) {
    if (d.isNew) {
      anyNew = true;
      ops.push({
        kind: 'create',
        draftId: d.id,
        input: { key: d.key, value_type: d.value_type, config: d.config },
      });
      continue;
    }
    const before = originalById.get(d.id);
    if (before === undefined) continue; // defensive — should not happen
    const changes: PropertyDefinitionUpdateInput = {};
    if (d.key !== before.key) changes.key = d.key;
    if (d.value_type !== before.value_type) changes.value_type = d.value_type;
    if (!configEqual(d.config, before.config)) changes.config = d.config;
    if (Object.keys(changes).length > 0) ops.push({ kind: 'update', id: d.id, changes });
  }
  const survivorIds = draft.filter((d) => !d.isNew).map((d) => d.id);
  const originalOrder = original.map((d) => d.id).filter((id) => survivorIds.includes(id));
  const orderChanged = JSON.stringify(originalOrder) !== JSON.stringify(survivorIds);
  return { ops, needsReorder: draft.length > 0 && (anyNew || orderChanged) };
}
