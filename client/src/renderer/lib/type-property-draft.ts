/**
 * Staged (draft) editing of a type's OWN property BINDINGS — task
 * «Клиент: редактор типа подключает свойство из справочника».
 *
 * Since 0.6.5 a type's own row is a binding to a network-wide property in
 * the registry (`properties` table), not a self-contained definition. The
 * binding carries only the property's role in this type (`required`,
 * `position`); the property's NATURE (name, value type, config, description)
 * lives in the registry and is edited through the property manager. The
 * `key`/`value_type`/`config`/`description` fields on a {@link DraftProperty}
 * are an immutable snapshot taken at attach time — the table needs them to
 * render the row, but the type editor never writes them back.
 *
 * The draft is the local state of the staged table:
 *   * add (attach an existing registry property, OR create a brand-new one
 *     and attach it in the same op),
 *   * toggle `required`,
 *   * reorder (▲/▼),
 *   * remove (unbind — keeps stored values).
 *
 * Everything is reconciled with the server only when the type editor's
 * «Применить и закрыть» runs. {@link planPropertyDiff} is the pure part of
 * that reconciliation — pulled out of the DOM-heavy dialog code so the
 * (non-trivial) diff logic is unit-testable without a network or a document.
 */

import type {
  AttachPropertyInput,
  PropertyConfig,
  PropertyDefinition,
  PropertyValueType,
} from '@etn/shared';

/**
 * One row of the staged own-bindings table. `isNew: false` rows are
 * persisted on the server (`id` is the real binding id, `property_id` is the
 * registry id the binding attaches). `isNew: true` rows were added during
 * this session and have not been created yet (`id` is a local placeholder
 * from {@link nextDraftPropertyId}); `createInRegistry` then says how they
 * will land on the server:
 *   * `false` — `POST /types/{id}/properties` with `{ mode: 'attach',
 *     property_id }` to bind an existing registry row;
 *   * `true`  — `POST /types/{id}/properties` with `{ mode: 'create', key,
 *     value_type, description }` to create the registry row AND the binding
 *     in one server-side transaction.
 */
export interface DraftProperty {
  id: string;
  isNew: boolean;
  /** Registry property id this binding attaches. For `isNew: true` with
   *  `createInRegistry: true` this is empty — the server assigns the new
   *  registry id (returned in the response payload). */
  property_id: string;
  /** Whether the property is required on this type's records (the binding's
   *  only editable aspect through the type editor). */
  required: boolean;
  /** Immutable snapshot of the property's nature for table rendering. */
  key: string;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
  description: string | null;
  /** See the type doc — only meaningful for `isNew: true`. */
  createInRegistry: boolean;
}

let draftCounter = 0;

/** A fresh placeholder id for a newly staged (not yet created) binding. */
export function nextDraftPropertyId(): string {
  draftCounter += 1;
  return `draft:${draftCounter}`;
}

/** Builds the initial staged list from a type's own (non-inherited)
 *  bindings, ordered as the server returns them (`position`, then `key`). */
export function draftPropertiesFrom(own: readonly PropertyDefinition[]): DraftProperty[] {
  return own.map((d) => ({
    id: d.id,
    isNew: false,
    property_id: d.property_id,
    required: d.required,
    key: d.key,
    value_type: d.value_type,
    config: d.config,
    description: d.description,
    createInRegistry: false,
  }));
}

/** One step of the Apply-time reconciliation plan (see {@link planPropertyDiff}). */
export type PropertyDiffOp =
  | { kind: 'unbind'; id: string }
  | {
      kind: 'attach';
      draftId: string;
      property_id: string;
      required: boolean;
    }
  | {
      kind: 'create-and-attach';
      draftId: string;
      name: string;
      value_type: PropertyValueType;
      description: string | null;
      required: boolean;
    }
  | { kind: 'set-role'; id: string; required: boolean };

/** Result of {@link planPropertyDiff}. */
export interface PropertyDiffPlan {
  ops: PropertyDiffOp[];
  /** Whether a final `reorderTypeProperties` call is needed once every
   *  attach/set-role above has run (a single reorder after the creates is
   *  simpler and just as correct as tracking `position` per op). */
  needsReorder: boolean;
}

/**
 * Computes the Apply-time plan for a type's staged own bindings:
 *   1. **unbinds** first (so a freed slot never collides with an attach in
 *      the same batch),
 *   2. then **attaches** / **create-and-attaches** in the drafted order
 *      (new rows always land via the trailing `needsReorder` call rather
 *      than by tracking `position` per op),
 *   3. then **set-role** ops for the `required` toggles on existing rows.
 * Pure — no network, no DOM.
 */
export function planPropertyDiff(
  original: readonly PropertyDefinition[],
  draft: readonly DraftProperty[],
  deletedIds: readonly string[],
): PropertyDiffPlan {
  const originalById = new Map(original.map((d) => [d.id, d]));
  const ops: PropertyDiffOp[] = [];

  // 1. Unbinds (deletions) first — never collides with a later attach of the
  //    same property id, and the server never sees a freed binding that the
  //    client then re-attaches in the same batch.
  for (const id of deletedIds) {
    ops.push({ kind: 'unbind', id });
  }

  // 2. New rows (attach or create-and-attach).
  let anyNew = false;
  for (const d of draft) {
    if (!d.isNew) continue;
    anyNew = true;
    if (d.createInRegistry) {
      ops.push({
        kind: 'create-and-attach',
        draftId: d.id,
        name: d.key,
        value_type: d.value_type,
        description: d.description,
        required: d.required,
      });
    } else {
      ops.push({
        kind: 'attach',
        draftId: d.id,
        property_id: d.property_id,
        required: d.required,
      });
    }
  }

  // 3. Role changes on existing rows. Skip ids the draft is also unbinding
  //    — a `set-role` after an `unbind` is a wasted round-trip (the server
  //    would 404 on the PATCH because the binding is already gone).
  const deletedSet = new Set(deletedIds);
  for (const d of draft) {
    if (d.isNew) continue;
    if (deletedSet.has(d.id)) continue;
    const before = originalById.get(d.id);
    if (before === undefined) continue; // defensive — should not happen
    if (d.required !== before.required) {
      ops.push({ kind: 'set-role', id: d.id, required: d.required });
    }
  }

  // Trailing reorder covers new rows landing in the middle and any explicit
  // ▲/▼ reorders. The exact positions don't matter for the diff — a single
  // `reorderTypeProperties(orderedIds)` at the end asserts the final order.
  const survivorIds = draft.filter((d) => !d.isNew).map((d) => d.id);
  const originalOrder = original
    .map((d) => d.id)
    .filter((id) => survivorIds.includes(id));
  const orderChanged = JSON.stringify(originalOrder) !== JSON.stringify(survivorIds);
  return { ops, needsReorder: anyNew || orderChanged };
}

/** Builds the body of `POST /types/{id}/properties` for one plan op. Pure. */
export function opToAttachInput(op: Extract<PropertyDiffOp, { kind: 'attach' | 'create-and-attach' }>): AttachPropertyInput {
  if (op.kind === 'attach') {
    return { mode: 'attach', property_id: op.property_id, required: op.required };
  }
  return {
    mode: 'create',
    key: op.name,
    value_type: op.value_type,
    description: op.description,
    required: op.required,
  };
}
