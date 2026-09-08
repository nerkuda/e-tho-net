/**
 * Composite batch write service for `etn.ontology.write` (задача cc9ca65e,
 * версия 0.7.2, docs/05-mcp-server.md §4.2b).
 *
 * Пишет онтологию сети одной SQL-транзакцией: типы мыслей + типы связей +
 * свойства реестра + привязки свойств к типам. Главный инструмент MCP для
 * управления онтологией из агентских сценариев.
 *
 * Алгоритм (две фазы внутри одной транзакции):
 *   1. **Resolve** — препроход: резолв `parent` / `parent_ref` / имён /
 *      `type_ref` / `property_ref`. Цикл `parent_ref` определяется на
 *      множестве создаваемых и существующих типов (L21 — дерево). На этом
 *      же шаге валидируются:
 *        * уникальность `ref` внутри каждого массива;
 *        * XOR `id` / `name` (или `parent` / `parent_ref`, `type` / `type_ref`,
 *          `property` / `property_ref`);
 *        * `value_type` против реестра `PROPERTY_VALUE_TYPES`;
 *        * все `ref` указывают на объявленный элемент в этом же батче.
 *   2. **Write** — пакетная запись: сначала `thought_types[]` (создание
 *      типов под корнем, если parent — ref из батча), затем фаза 1.5 —
 *      обновление `parent_id` для типов, чьи parent из батча; затем
 *      `link_types[]` + фаза 1.5 для них; затем `properties[]`; затем
 *      `type_properties[]`.
 *
 * Все ошибки внутри транзакции откатывают ВЕСЬ вызов — вызывающий никогда
 * не видит полузаписанной онтологии.
 */

import {
  EtnError,
  PROPERTY_VALUE_TYPES,
  TYPE_OWNER_TYPES,
  typeNameKey,
  type IconKind,
  type LinkStyle,
  type OntologyDeleteAffectedCounts,
  type OntologyDeleteKind,
  type OntologyDeleteParams,
  type OntologyDeleteResult,
  type OntologyWriteLinkType,
  type OntologyWriteLinkTypeResult,
  type OntologyWriteParams,
  type OntologyWriteProperty,
  type OntologyWritePropertyResult,
  type OntologyWriteResult,
  type OntologyWriteThoughtType,
  type OntologyWriteThoughtTypeResult,
  type OntologyWriteTypeProperty,
  type OntologyWriteTypePropertyResult,
  type OntologyWriteTypeView,
  type OntologyWriteTypeViewAction,
  type OntologyWriteTypeViewResult,
  type PropertyConfig,
  type PropertyDefinition,
  type PropertyValueType,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
  type LinkTypeInput,
  type LinkTypeUpdateInput,
  type NetworkPropertyInput,
  type NetworkPropertyUpdateInput,
  type TypeOwnerType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  createLinkType,
  getLinkType,
  resolveLinkTypeIdByName,
  updateLinkType,
} from './link-type-service.js';
import {
  createThoughtType,
  getThoughtType,
  resolveThoughtTypeIdByName,
  updateThoughtType,
} from './thought-type-service.js';
import {
  createNetworkProperty,
  createTypeProperty,
  getNetworkProperty,
  getNetworkPropertyByName,
  getTypePropertyByKey,
  resolvePropertyIdByName,
  updateNetworkProperty,
  updateTypeProperty,
} from './property-service.js';
import { assertParentValid } from './type-hierarchy.js';
import {
  createThoughtTypeView,
  deleteThoughtTypeView,
  getThoughtTypeView,
  updateThoughtTypeView,
} from './thought-type-views-service.js';

export {
  EtnError,
  type OntologyDeleteAffectedCounts,
  type OntologyDeleteKind,
  type OntologyDeleteParams,
  type OntologyDeleteResult,
  type OntologyWriteLinkType,
  type OntologyWriteLinkTypeResult,
  type OntologyWriteParams,
  type OntologyWriteProperty,
  type OntologyWritePropertyResult,
  type OntologyWriteResult,
  type OntologyWriteThoughtType,
  type OntologyWriteThoughtTypeResult,
  type OntologyWriteTypeProperty,
  type OntologyWriteTypePropertyResult,
  type OntologyWriteTypeView,
  type OntologyWriteTypeViewAction,
  type OntologyWriteTypeViewResult,
};

// ===========================================================================
// Resolve helpers
// ===========================================================================

/** Желаемый `parent_id` для типа. */
type ParentResolution =
  | { kind: 'existing'; id: string }
  | { kind: 'ref'; ref: string }
  | { kind: 'root' }
  | { kind: 'unchanged' };

/** Внутреннее представление элемента `thought_types[]` после resolve. */
interface ResolvedThoughtType {
  index: number;
  ref: string | null;
  id: string | null;
  name: string;
  parent: ParentResolution;
  description: string | null | undefined;
  icon: string | null | undefined;
  icon_kind: IconKind | undefined;
  fg_color: string | null | undefined;
  bg_color: string | null | undefined;
  font_bold: boolean | null | undefined;
  font_italic: boolean | null | undefined;
  font_underline: boolean | null | undefined;
  font_strike: boolean | null | undefined;
  comment_template_md: string | null | undefined;
}

interface ResolvedLinkType {
  index: number;
  ref: string | null;
  id: string | null;
  name_forward: string | undefined;
  name_reverse: string | undefined;
  parent: ParentResolution;
  color: string | null | undefined;
  style: LinkStyle | null | undefined;
  width: number | null | undefined;
  description: string | null | undefined;
}

interface ResolvedProperty {
  index: number;
  ref: string | null;
  id: string | null;
  name: string;
  value_type: PropertyValueType | undefined;
  config: PropertyConfig | null | undefined;
  description: string | null | undefined;
}

interface ResolvedTypeProperty {
  index: number;
  owner: TypeOwnerType;
  /** Либо existing id (из БД), либо ref из батча. Резолвится в write-фазе. */
  typeRef: { kind: 'existing'; id: string } | { kind: 'batch_ref'; ref: string };
  propertyRef:
    | { kind: 'existing'; id: string }
    | { kind: 'batch_ref'; ref: string };
  type_ref: string | null;
  property_ref: string | null;
  required: boolean;
  position: number | undefined;
}

/**
 * Внутреннее представление элемента `type_views[]` после resolve (задача
 * c1fa71d4, 0.7.3). Проще `ResolvedTypeProperty`: тип-владелец ровно один
 * (нет owner), `id`/`ref_for_update` адресует существующий или только что
 * созданный в этом же батче отбор.
 */
interface ResolvedTypeView {
  index: number;
  ref: string | null;
  action: OntologyWriteTypeView['action'];
  /** Id существующего отбора для update/delete (или resolved из
   *  `ref_for_update` после write-фазы). `null` для create. */
  viewId: string | null;
  /** Локальный `ref` другого `type_views[]` из этого же батча, который
   *  должен быть разрешён в id после write-фазы. */
  ref_for_update: string | null;
  /** Тип-владелец отбора: existing id или batch_ref. */
  thoughtTypeRef:
    | { kind: 'existing'; id: string }
    | { kind: 'batch_ref'; ref: string };
  thought_type_ref: string | null;
  name: string | undefined;
  description: string | null | undefined;
  definition: string | undefined;
  position: number | undefined;
  is_default: boolean | undefined;
}

// ===========================================================================
// Validation helpers
// ===========================================================================

function collectRefs<T extends { ref?: string }>(
  items: T[] | undefined,
  sectionLabel: string,
): { definedRefs: Set<string> } {
  const definedRefs = new Set<string>();
  if (items === undefined) return { definedRefs };
  for (const [index, item] of items.entries()) {
    if (item.ref !== undefined) {
      if (item.ref === '') {
        throw new EtnError('VALIDATION_ERROR', 'ref must be a non-empty string', {
          field: `${sectionLabel}[${index}].ref`,
        });
      }
      if (definedRefs.has(item.ref)) {
        throw new EtnError('VALIDATION_ERROR', `duplicate ref in batch: "${item.ref}"`, {
          field: `${sectionLabel}[${index}].ref`,
          ref: item.ref,
        });
      }
      definedRefs.add(item.ref);
    }
  }
  return { definedRefs };
}

function checkParentRefs(
  sectionLabel: string,
  items: Array<{ ref?: string; parent_ref?: string | null }> | undefined,
  definedRefs: Set<string>,
): void {
  if (items === undefined) return;
  for (const [index, item] of items.entries()) {
    const ref = item.parent_ref;
    if (ref === undefined || ref === null) continue;
    if (ref === '') {
      throw new EtnError('VALIDATION_ERROR', 'parent_ref must be a non-empty string or null', {
        field: `${sectionLabel}[${index}].parent_ref`,
      });
    }
    if (!definedRefs.has(ref)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `parent_ref "${ref}" is not declared in this batch`,
        {
          field: `${sectionLabel}[${index}].parent_ref`,
          parent_ref: ref,
          known_refs: Array.from(definedRefs),
        },
      );
    }
  }
}

function validateIdNameXor<T extends { id?: string | null; name?: string }>(
  item: T,
  sectionLabel: string,
  index: number,
): void {
  const hasId = item.id !== undefined && item.id !== null;
  const hasName = item.name !== undefined && item.name !== null && item.name !== '';
  if (!hasId && !hasName) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${sectionLabel}[${index}] must set at least one of id or name`,
      { field: `${sectionLabel}[${index}]` },
    );
  }
}

function validateParentXor<T extends { parent?: string | null; parent_ref?: string | null }>(
  item: T,
  sectionLabel: string,
  index: number,
): void {
  const hasParent = item.parent !== undefined && item.parent !== null && item.parent !== '';
  const hasParentRef = item.parent_ref !== undefined && item.parent_ref !== null;
  if (hasParent && hasParentRef) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${sectionLabel}[${index}] must set at most one of parent or parent_ref`,
      { field: `${sectionLabel}[${index}]` },
    );
  }
}

// ===========================================================================
// Resolve pass
// ===========================================================================

function resolveThoughtTypes(
  ndb: NetworkDb,
  items: OntologyWriteThoughtType[] | undefined,
  definedRefs: Set<string>,
): ResolvedThoughtType[] {
  if (items === undefined) return [];
  const out: ResolvedThoughtType[] = [];
  for (const [index, item] of items.entries()) {
    validateIdNameXor(item, 'thought_types', index);
    validateParentXor(item, 'thought_types', index);
    let id: string | null = null;
    if (item.id !== undefined && item.id !== null) {
      const existing = getThoughtType(ndb, item.id);
      if (existing === null) {
        throw new EtnError('NOT_FOUND', `thought type ${item.id} not found`, {
          entity: 'thought_type',
          id: item.id,
          field: `thought_types[${index}].id`,
        });
      }
      id = existing.id;
    } else if (item.name !== undefined && item.name !== null && item.name !== '') {
      const existing = ndb
        .prepare('SELECT id FROM thought_types_v WHERE name_key = ?')
        .get(typeNameKey(item.name)) as { id: string } | undefined;
      if (existing !== undefined) id = existing.id;
    }
    let parent: ParentResolution;
    if (item.parent !== undefined && item.parent !== null && item.parent !== '') {
      const pe = getThoughtType(ndb, item.parent);
      if (pe === null) {
        throw new EtnError('NOT_FOUND', `thought type ${item.parent} not found`, {
          entity: 'thought_type',
          id: item.parent,
          field: `thought_types[${index}].parent`,
        });
      }
      parent = { kind: 'existing', id: pe.id };
    } else if (item.parent_ref !== undefined && item.parent_ref !== null) {
      parent = { kind: 'ref', ref: item.parent_ref };
    } else if (id === null) {
      parent = { kind: 'root' };
    } else {
      parent = { kind: 'unchanged' };
    }
    out.push({
      index,
      ref: item.ref ?? null,
      id,
      name: item.name ?? '',
      parent,
      description: item.description,
      icon: item.icon,
      icon_kind: item.icon_kind,
      fg_color: item.fg_color,
      bg_color: item.bg_color,
      font_bold: item.font_bold,
      font_italic: item.font_italic,
      font_underline: item.font_underline,
      font_strike: item.font_strike,
      comment_template_md: item.comment_template_md,
    });
  }
  checkParentRefs('thought_types', items, definedRefs);
  return out;
}

function resolveLinkTypes(
  ndb: NetworkDb,
  items: OntologyWriteLinkType[] | undefined,
  definedRefs: Set<string>,
): ResolvedLinkType[] {
  if (items === undefined) return [];
  const out: ResolvedLinkType[] = [];
  for (const [index, item] of items.entries()) {
    const hasId = item.id !== undefined && item.id !== null;
    const hasNamePair = item.name_forward !== undefined || item.name_reverse !== undefined;
    if (!hasId && !hasNamePair) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `link_types[${index}] must set id or (name_forward/name_reverse)`,
        { field: `link_types[${index}]` },
      );
    }
    validateParentXor(item, 'link_types', index);
    let id: string | null = null;
    if (hasId) {
      const existing = getLinkType(ndb, item.id!);
      if (existing === null) {
        throw new EtnError('NOT_FOUND', `link type ${item.id} not found`, {
          entity: 'link_type',
          id: item.id!,
          field: `link_types[${index}].id`,
        });
      }
      id = existing.id;
    } else if (item.name_forward !== undefined && item.name_reverse !== undefined) {
      const fwdKey = typeNameKey(item.name_forward);
      const revKey = typeNameKey(item.name_reverse);
      const existing = ndb
        .prepare(
          'SELECT id FROM link_types_v WHERE name_forward_key = ? AND name_reverse_key = ?',
        )
        .get(fwdKey, revKey) as { id: string } | undefined;
      if (existing !== undefined) id = existing.id;
    }
    let parent: ParentResolution;
    if (item.parent !== undefined && item.parent !== null && item.parent !== '') {
      const pe = getLinkType(ndb, item.parent);
      if (pe === null) {
        throw new EtnError('NOT_FOUND', `link type ${item.parent} not found`, {
          entity: 'link_type',
          id: item.parent,
          field: `link_types[${index}].parent`,
        });
      }
      parent = { kind: 'existing', id: pe.id };
    } else if (item.parent_ref !== undefined && item.parent_ref !== null) {
      parent = { kind: 'ref', ref: item.parent_ref };
    } else if (id === null) {
      parent = { kind: 'root' };
    } else {
      parent = { kind: 'unchanged' };
    }
    out.push({
      index,
      ref: item.ref ?? null,
      id,
      name_forward: item.name_forward,
      name_reverse: item.name_reverse,
      parent,
      color: item.color,
      style: item.style,
      width: item.width,
      description: item.description,
    });
  }
  checkParentRefs('link_types', items, definedRefs);
  return out;
}

function resolveProperties(
  ndb: NetworkDb,
  items: OntologyWriteProperty[] | undefined,
): ResolvedProperty[] {
  if (items === undefined) return [];
  const out: ResolvedProperty[] = [];
  for (const [index, item] of items.entries()) {
    validateIdNameXor(item, 'properties', index);
    if (
      item.value_type !== undefined &&
      !(PROPERTY_VALUE_TYPES as readonly string[]).includes(item.value_type)
    ) {
      throw new EtnError('VALIDATION_ERROR', `invalid value_type: ${item.value_type}`, {
        field: `properties[${index}].value_type`,
        allowed: PROPERTY_VALUE_TYPES,
      });
    }
    let id: string | null = null;
    if (item.id !== undefined && item.id !== null) {
      const existing = getNetworkProperty(ndb, item.id);
      if (existing === null) {
        throw new EtnError('NOT_FOUND', `property ${item.id} not found`, {
          entity: 'property',
          id: item.id,
          field: `properties[${index}].id`,
        });
      }
      id = existing.id;
    } else if (item.name !== undefined && item.name !== null && item.name !== '') {
      const existing = getNetworkPropertyByName(ndb, item.name);
      if (existing !== null) id = existing.id;
    }
    out.push({
      index,
      ref: item.ref ?? null,
      id,
      name: item.name ?? '',
      value_type: item.value_type,
      config: item.config,
      description: item.description,
    });
  }
  return out;
}

function resolveTypeProperties(
  ndb: NetworkDb,
  items: OntologyWriteTypeProperty[] | undefined,
  ttDefinedRefs: Set<string>,
  ltDefinedRefs: Set<string>,
  pDefinedRefs: Set<string>,
): ResolvedTypeProperty[] {
  if (items === undefined) return [];
  const out: ResolvedTypeProperty[] = [];
  for (const [index, item] of items.entries()) {
    if (!(TYPE_OWNER_TYPES as readonly string[]).includes(item.owner)) {
      throw new EtnError('VALIDATION_ERROR', `invalid owner: ${item.owner}`, {
        field: `type_properties[${index}].owner`,
        allowed: TYPE_OWNER_TYPES,
      });
    }
    const hasType = item.type !== undefined && item.type !== null && item.type !== '';
    const hasTypeRef = item.type_ref !== undefined && item.type_ref !== null;
    if (hasType === hasTypeRef) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `type_properties[${index}] must set exactly one of type or type_ref`,
        { field: `type_properties[${index}]` },
      );
    }
    const hasProperty =
      item.property !== undefined && item.property !== null && item.property !== '';
    const hasPropertyRef = item.property_ref !== undefined && item.property_ref !== null;
    if (hasProperty === hasPropertyRef) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `type_properties[${index}] must set exactly one of property or property_ref`,
        { field: `type_properties[${index}]` },
      );
    }
    let typeRef: ResolvedTypeProperty['typeRef'];
    if (hasType) {
      const id =
        item.owner === 'thought_type'
          ? resolveThoughtTypeIdByName(ndb, item.type as string)
          : resolveLinkTypeIdByName(ndb, item.type as string);
      typeRef = { kind: 'existing', id };
    } else {
      const ref = item.type_ref as string;
      const validSet = item.owner === 'thought_type' ? ttDefinedRefs : ltDefinedRefs;
      const oppositeSet = item.owner === 'thought_type' ? ltDefinedRefs : ttDefinedRefs;
      if (oppositeSet.has(ref) && !validSet.has(ref)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `type_ref "${ref}" указывает на ${item.owner === 'thought_type' ? 'link_type' : 'thought_type'}, но owner=${item.owner}`,
          { field: `type_properties[${index}].type_ref` },
        );
      }
      if (!validSet.has(ref)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `type_ref "${ref}" is not declared in this batch`,
          { field: `type_properties[${index}].type_ref` },
        );
      }
      typeRef = { kind: 'batch_ref', ref };
    }
    let propertyRef: ResolvedTypeProperty['propertyRef'];
    if (hasProperty) {
      propertyRef = {
        kind: 'existing',
        id: resolvePropertyIdByName(ndb, item.property as string),
      };
    } else {
      const ref = item.property_ref as string;
      if (!pDefinedRefs.has(ref)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property_ref "${ref}" is not declared in this batch`,
          { field: `type_properties[${index}].property_ref` },
        );
      }
      propertyRef = { kind: 'batch_ref', ref };
    }
    out.push({
      index,
      owner: item.owner,
      typeRef,
      propertyRef,
      type_ref: hasTypeRef ? (item.type_ref as string) : null,
      property_ref: hasPropertyRef ? (item.property_ref as string) : null,
      required: item.required ?? false,
      position: item.position,
    });
  }
  return out;
}

/**
 * Резолв `type_views[]` (задача c1fa71d4, 0.7.3, ADR 5c44f6a7). Здесь
 * проверяется синтаксис полей, XOR `thought_type` / `thought_type_ref`,
 * существование `id` для update/delete, объявленность `ref_for_update` в
 * `type_views[]` этого же батча. Полная доменная валидация (включая
 * токены и уникальность имени) — внутри `createThoughtTypeView` /
 * `updateThoughtTypeView`, чтобы не дублировать правила.
 *
 * Тип-владелец должен существовать либо быть объявлен в `thought_types[]`
 * этого же батча — иначе `VALIDATION_ERROR` со списком известных `ref`.
 * Удаление отбора (`action: 'delete'`) не требует `name` / `definition`
 * — остальные поля игнорируются, кроме адресации.
 */
function resolveTypeViews(
  ndb: NetworkDb,
  items: OntologyWriteTypeView[] | undefined,
  tvRefs: Set<string>,
  ttDefinedRefs: Set<string>,
): ResolvedTypeView[] {
  if (items === undefined) return [];
  const out: ResolvedTypeView[] = [];
  for (const [index, item] of items.entries()) {
    if (item.action !== 'create' && item.action !== 'update' && item.action !== 'delete') {
      throw new EtnError(
        'VALIDATION_ERROR',
        `type_views[${index}].action must be create|update|delete`,
        { field: `type_views[${index}].action`, allowed: ['create', 'update', 'delete'] },
      );
    }
    let viewId: string | null = null;
    if (item.id !== undefined && item.id !== undefined && item.id !== null) {
      const existing = getThoughtTypeView(ndb, item.id);
      if (existing === null) {
        throw new EtnError('NOT_FOUND', `thought_type_view ${item.id} not found`, {
          entity: 'thought_type_view',
          id: item.id,
          field: `type_views[${index}].id`,
        });
      }
      viewId = existing.id;
    }
    let refForUpdate: string | null = item.ref_for_update ?? null;
    if (refForUpdate !== null && !tvRefs.has(refForUpdate)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `ref_for_update "${refForUpdate}" is not declared in this batch`,
        { field: `type_views[${index}].ref_for_update`, ref_for_update: refForUpdate },
      );
    }
    // XOR `thought_type` / `thought_type_ref` только если тип указывается
    // (для create обязателен, для update/delete опционален — тип не меняется).
    const hasType = item.thought_type !== undefined && item.thought_type !== null && item.thought_type !== '';
    const hasTypeRef = item.thought_type_ref !== undefined && item.thought_type_ref !== null;
    if (hasType && hasTypeRef) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `type_views[${index}] must set at most one of thought_type or thought_type_ref`,
        { field: `type_views[${index}]` },
      );
    }
    let thoughtTypeRef: ResolvedTypeView['thoughtTypeRef'];
    if (hasType) {
      const id = resolveThoughtTypeIdByName(ndb, item.thought_type as string);
      thoughtTypeRef = { kind: 'existing', id };
    } else if (hasTypeRef) {
      const ref = item.thought_type_ref as string;
      if (!ttDefinedRefs.has(ref)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `thought_type_ref "${ref}" is not declared in this batch`,
          { field: `type_views[${index}].thought_type_ref`, thought_type_ref: ref },
        );
      }
      thoughtTypeRef = { kind: 'batch_ref', ref };
    } else if (item.action === 'create') {
      throw new EtnError(
        'VALIDATION_ERROR',
        `type_views[${index}] with action=create requires thought_type or thought_type_ref`,
        { field: `type_views[${index}]` },
      );
    } else {
      // update/delete без указания типа — id/ref_for_update уже задаёт
      // адрес существующего отбора, тип берём из него. Резолв в write-фазе.
      thoughtTypeRef = { kind: 'existing', id: '' };
    }
    out.push({
      index,
      ref: item.ref ?? null,
      action: item.action,
      viewId,
      ref_for_update: refForUpdate,
      thoughtTypeRef,
      thought_type_ref: hasTypeRef ? (item.thought_type_ref as string) : null,
      name: item.name,
      description: item.description,
      definition: item.definition,
      position: item.position,
      is_default: item.is_default,
    });
  }
  return out;
}

// ===========================================================================
// Hierarchy cycle / depth validation
// ===========================================================================

/**
 * Проверить parent_ref на цикл и превышение MAX_TYPE_DEPTH. Граф строится
 * из resolved-данных. На этом этапе id новых типов ещё не известны
 * (randomUUID ещё не сгенерирован), но для определения цикла между
 * создаваемыми типами достаточно проверить, что parent_ref не указывает
 * на элемент, который (прямо или через цепочку parent_ref → parent_ref)
 * указывает на наш элемент. Финальная проверка цикла между новым типом и
 * существующим — после resolve parent_ref в id (фаза 1.5).
 */
function validateRefHierarchy(
  resolved: Array<{ ref: string | null; id: string | null; parent: ParentResolution }>,
  sectionLabel: string,
): void {
  const refToIdx = new Map<string, number>();
  for (const [i, r] of resolved.entries()) {
    if (r.ref !== null) refToIdx.set(r.ref, i);
  }
  // Соберём граф по parent_ref.
  const edges = new Map<string, string | null>();
  for (const r of resolved) {
    if (r.ref === null) continue;
    if (r.parent.kind === 'ref') {
      edges.set(r.ref, r.parent.ref);
    } else if (r.parent.kind === 'root') {
      edges.set(r.ref, null);
    }
    // 'existing' и 'unchanged' не учитываем в этом проходе — они
    // валидируются в фазе 1.5 через assertParentValid.
  }
  // DFS с обнаружением back-edge.
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 gray, 2 black
  const dfs = (ref: string): void => {
    color.set(ref, 1);
    const target = edges.get(ref);
    if (target !== undefined && target !== null) {
      const t = color.get(target);
      if (t === 1) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `цикл в parent_ref: иерархия ${sectionLabel} должна быть деревом`,
          { cycle: Array.from(color.keys()).filter((k) => color.get(k) === 1) },
        );
      }
      if (t === undefined || t === 0) dfs(target);
    }
    color.set(ref, 2);
  };
  for (const ref of edges.keys()) {
    if ((color.get(ref) ?? 0) === 0) dfs(ref);
  }
  // Проверим глубину среди parent_ref цепочек.
  let depth = 0;
  for (const ref of edges.keys()) {
    let d = 0;
    let cur: string | null | undefined = ref;
    const seen = new Set<string>();
    while (cur !== undefined && cur !== null) {
      if (seen.has(cur)) break;
      seen.add(cur);
      d += 1;
      cur = edges.get(cur);
      if (d > 8) break;
    }
    if (d > depth) depth = d;
  }
  if (depth > 4) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `вложенность типов ограничена 4 уровнями, включая корневой тип (${sectionLabel})`,
      { depth },
    );
  }
}

// ===========================================================================
// Converted / dropped classification (для properties[])
// ===========================================================================

function classifyStoredValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): { converted: number; dropped: number } {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}($|T)/;
  const rows = ndb
    .prepare(
      `SELECT value_text, value_date, value_number, value_bool, value_thought_ref
       FROM property_values_v WHERE property_id = ?`,
    )
    .all(propertyId) as Array<{
    value_text: string | null;
    value_date: string | null;
    value_number: number | null;
    value_bool: number | null;
    value_thought_ref: string | null;
  }>;
  let converted = 0;
  let dropped = 0;
  for (const row of rows) {
    let value: string | number | boolean | string[] | null = null;
    switch (from) {
      case 'text':
      case 'url':
        value = row.value_text;
        break;
      case 'date':
        value = row.value_date;
        break;
      case 'number':
        value = row.value_number;
        break;
      case 'bool':
        value = row.value_bool === null ? null : row.value_bool === 1;
        break;
      case 'thought_ref': {
        const raw = row.value_thought_ref;
        if (raw === null) value = null;
        else if (raw.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(raw);
            value = Array.isArray(parsed)
              ? (parsed.filter((v): v is string => typeof v === 'string') as string[])
              : [];
          } catch {
            value = [];
          }
        } else value = raw;
        break;
      }
    }
    if (canConvert(value, to, ISO_DATE_RE)) converted += 1;
    else dropped += 1;
  }
  return { converted, dropped };
}

function canConvert(
  value: string | number | boolean | string[] | null,
  to: PropertyValueType,
  ISO_DATE_RE: RegExp,
): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) {
    return to === 'text' || to === 'url';
  }
  switch (to) {
    case 'text':
    case 'url':
      return true;
    case 'number': {
      if (typeof value === 'number') return true;
      if (typeof value === 'boolean') return true;
      const trimmed = value.trim();
      if (trimmed === '') return false;
      const n = Number(trimmed);
      return Number.isFinite(n);
    }
    case 'date':
      return (
        typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))
      );
    case 'bool':
      if (typeof value === 'boolean') return true;
      if (typeof value === 'number' && (value === 0 || value === 1)) return true;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === 'true' || s === 'да' || s === '1' || s === 'false' || s === 'нет' || s === '0';
      }
      return false;
    case 'thought_ref':
      return false;
  }
}

/** Прочитать `base_version` строки из таблицы. У типов и свойств нет
 *  отдельной колонки `version` — используется `base_version`, которая
 *  инкрементируется на каждой записи (L21). */
function readVersion(
  ndb: NetworkDb,
  table: 'thought_types' | 'link_types' | 'properties' | 'type_properties',
  id: string,
): number {
  const row = ndb
    .prepare(`SELECT base_version FROM ${table} WHERE id = ? AND layer_id = ?`)
    .get(id, ndb.layerId) as { base_version: number } | undefined;
  return row?.base_version ?? 0;
}

// ===========================================================================
// Main entrypoint
// ===========================================================================

/** Записать батч `etn.ontology.write` одной транзакцией. */
export function writeOntology(
  ndb: NetworkDb,
  input: OntologyWriteParams,
  actorUserId: string,
): OntologyWriteResult {
  // -- Validation pass -------------------------------------------------------
  const ttRefs = collectRefs(input.thought_types, 'thought_types');
  const ltRefs = collectRefs(input.link_types, 'link_types');
  const pRefs = collectRefs(input.properties, 'properties');
  const tvRefs = collectRefs(input.type_views, 'type_views');

  // -- Resolve pass ----------------------------------------------------------
  const resolvedThoughtTypes = resolveThoughtTypes(ndb, input.thought_types, ttRefs.definedRefs);
  const resolvedLinkTypes = resolveLinkTypes(ndb, input.link_types, ltRefs.definedRefs);
  const resolvedProperties = resolveProperties(ndb, input.properties);
  // type_views (задача c1fa71d4): резолв после типов, чтобы `thought_type_ref`
  // мог адресовать тип, объявленный в этом же батче. `thoughtTypeRef.id` для
  // batch_ref подставляется в write-фазе из `ttIdByRef`.
  const resolvedTypeViews = resolveTypeViews(
    ndb,
    input.type_views,
    tvRefs.definedRefs,
    ttRefs.definedRefs,
  );

  // Цикл / глубина среди parent_ref.
  validateRefHierarchy(resolvedThoughtTypes, 'thought_types');
  validateRefHierarchy(resolvedLinkTypes, 'link_types');

  // -- Write pass ------------------------------------------------------------
  return ndb.transaction(() => {
    // Maps ref → id, заполняются как существующими, так и свежесозданными.
    const ttIdByRef = new Map<string, string>();
    for (const r of resolvedThoughtTypes) {
      if (r.ref !== null && r.id !== null) ttIdByRef.set(r.ref, r.id);
    }
    const ltIdByRef = new Map<string, string>();
    for (const r of resolvedLinkTypes) {
      if (r.ref !== null && r.id !== null) ltIdByRef.set(r.ref, r.id);
    }
    const propIdByRef = new Map<string, string>();
    for (const r of resolvedProperties) {
      if (r.ref !== null && r.id !== null) propIdByRef.set(r.ref, r.id);
    }

    // ---- thought_types -------------------------------------------------
    const ttResults: OntologyWriteThoughtTypeResult[] = [];
    for (const item of resolvedThoughtTypes) {
      let id = item.id;
      let version = 0;
      let action: OntologyWriteThoughtTypeResult['action'] = 'unchanged';
      if (id === null) {
        const createInput: ThoughtTypeInput = {
          name: item.name,
          ...(item.parent.kind === 'existing' ? { parent_id: item.parent.id } : {}),
          ...(item.icon !== undefined ? { icon: item.icon } : {}),
          ...(item.icon_kind !== undefined ? { icon_kind: item.icon_kind } : {}),
          ...(item.fg_color !== undefined ? { fg_color: item.fg_color } : {}),
          ...(item.bg_color !== undefined ? { bg_color: item.bg_color } : {}),
          ...(item.font_bold !== undefined ? { font_bold: item.font_bold } : {}),
          ...(item.font_italic !== undefined ? { font_italic: item.font_italic } : {}),
          ...(item.font_underline !== undefined ? { font_underline: item.font_underline } : {}),
          ...(item.font_strike !== undefined ? { font_strike: item.font_strike } : {}),
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.comment_template_md !== undefined
            ? { comment_template_md: item.comment_template_md }
            : {}),
        };
        const created = createThoughtType(ndb, createInput, actorUserId);
        id = created.id;
        version = readVersion(ndb, 'thought_types', id);
        action = 'created';
      } else {
        const existing = getThoughtType(ndb, id);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `thought type ${id} not found`, {
            entity: 'thought_type',
            id,
          });
        }
        const updateInput: ThoughtTypeUpdateInput = {};
        if (item.name !== '' && item.name !== existing.name) updateInput.name = item.name;
        if (item.description !== undefined && item.description !== existing.description) {
          updateInput.description = item.description;
        }
        if (item.icon !== undefined && item.icon !== existing.icon) updateInput.icon = item.icon;
        if (item.icon_kind !== undefined && item.icon_kind !== existing.icon_kind) {
          updateInput.icon_kind = item.icon_kind;
        }
        if (item.fg_color !== undefined && item.fg_color !== existing.fg_color) {
          updateInput.fg_color = item.fg_color;
        }
        if (item.bg_color !== undefined && item.bg_color !== existing.bg_color) {
          updateInput.bg_color = item.bg_color;
        }
        if (item.font_bold !== undefined && item.font_bold !== existing.font_bold) {
          updateInput.font_bold = item.font_bold;
        }
        if (item.font_italic !== undefined && item.font_italic !== existing.font_italic) {
          updateInput.font_italic = item.font_italic;
        }
        if (item.font_underline !== undefined && item.font_underline !== existing.font_underline) {
          updateInput.font_underline = item.font_underline;
        }
        if (item.font_strike !== undefined && item.font_strike !== existing.font_strike) {
          updateInput.font_strike = item.font_strike;
        }
        if (
          item.comment_template_md !== undefined &&
          item.comment_template_md !== existing.comment_template_md
        ) {
          updateInput.comment_template_md = item.comment_template_md;
        }
        if (Object.keys(updateInput).length > 0) {
          updateThoughtType(ndb, id, updateInput, undefined, actorUserId);
          version = readVersion(ndb, 'thought_types', id);
          action = 'updated';
        } else {
          version = readVersion(ndb, 'thought_types', id);
          action = 'unchanged';
        }
      }
      ttResults.push({ ref: item.ref, id, version, action });
      if (item.ref !== null) ttIdByRef.set(item.ref, id);
    }

    // ---- фаза 1.5 — обновить parent_id ---------------------------------
    for (const item of resolvedThoughtTypes) {
      if (item.parent.kind !== 'ref') continue;
      const targetId = ttIdByRef.get(item.parent.ref);
      if (targetId === undefined) continue;
      // item.id мог быть null до write; используем актуальный id из ttResults.
      const id = ttIdByRef.get(item.ref ?? '') ?? ttResults.find((x) => x.ref === item.ref)?.id;
      if (id === undefined) continue;
      const existing = getThoughtType(ndb, id);
      if (existing === null) continue;
      if (existing.parent_id === targetId) continue;
      assertParentValid(ndb, 'thought_types', id, targetId);
      const updated = updateThoughtType(
        ndb,
        id,
        { parent_id: targetId },
        undefined,
        actorUserId,
      );
      const r = ttResults.find((x) => x.id === id);
      if (r !== undefined) {
        r.version = updated.version;
        if (r.action === 'unchanged') r.action = 'updated';
      }
    }

    // ---- link_types ----------------------------------------------------
    const ltResults: OntologyWriteLinkTypeResult[] = [];
    for (const item of resolvedLinkTypes) {
      let id = item.id;
      let version = 0;
      let action: OntologyWriteLinkTypeResult['action'] = 'unchanged';
      if (id === null) {
        if (item.name_forward === undefined || item.name_reverse === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `link_types[${item.index}] without id requires name_forward and name_reverse`,
            { field: `link_types[${item.index}]` },
          );
        }
        const createInput: LinkTypeInput = {
          name_forward: item.name_forward,
          name_reverse: item.name_reverse,
          ...(item.parent.kind === 'existing' ? { parent_id: item.parent.id } : {}),
          ...(item.color !== undefined ? { color: item.color } : {}),
          ...(item.style !== undefined ? { style: item.style } : {}),
          ...(item.width !== undefined ? { width: item.width } : {}),
          ...(item.description !== undefined ? { description: item.description } : {}),
        };
        const created = createLinkType(ndb, createInput, actorUserId);
        id = created.id;
        version = readVersion(ndb, 'link_types', id);
        action = 'created';
      } else {
        const existing = getLinkType(ndb, id);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `link type ${id} not found`, {
            entity: 'link_type',
            id,
          });
        }
        const updateInput: LinkTypeUpdateInput = {};
        if (item.name_forward !== undefined && item.name_forward !== existing.name_forward) {
          updateInput.name_forward = item.name_forward;
        }
        if (item.name_reverse !== undefined && item.name_reverse !== existing.name_reverse) {
          updateInput.name_reverse = item.name_reverse;
        }
        if (item.color !== undefined && item.color !== existing.color) updateInput.color = item.color;
        if (item.style !== undefined && item.style !== existing.style) updateInput.style = item.style;
        if (item.width !== undefined && item.width !== existing.width) updateInput.width = item.width;
        if (item.description !== undefined && item.description !== existing.description) {
          updateInput.description = item.description;
        }
        if (Object.keys(updateInput).length > 0) {
          updateLinkType(ndb, id, updateInput, undefined, actorUserId);
          version = readVersion(ndb, 'link_types', id);
          action = 'updated';
        } else {
          version = readVersion(ndb, 'link_types', id);
          action = 'unchanged';
        }
      }
      ltResults.push({ ref: item.ref, id, version, action });
      if (item.ref !== null) ltIdByRef.set(item.ref, id);
    }
    for (const item of resolvedLinkTypes) {
      if (item.parent.kind !== 'ref') continue;
      const targetId = ltIdByRef.get(item.parent.ref);
      if (targetId === undefined) continue;
      const id = item.id!;
      const existing = getLinkType(ndb, id);
      if (existing === null) continue;
      if (existing.parent_id === targetId) continue;
      assertParentValid(ndb, 'link_types', id, targetId);
      const updated = updateLinkType(
        ndb,
        id,
        { parent_id: targetId },
        undefined,
        actorUserId,
      );
      const r = ltResults.find((x) => x.id === id);
      if (r !== undefined) {
        r.version = updated.version;
        if (r.action === 'unchanged') r.action = 'updated';
      }
    }

    // ---- properties ----------------------------------------------------
    const propResults: OntologyWritePropertyResult[] = [];
    for (const item of resolvedProperties) {
      let id = item.id;
      let version = 0;
      let action: OntologyWritePropertyResult['action'] = 'unchanged';
      let converted = 0;
      let dropped = 0;
      if (id === null) {
        if (item.value_type === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `properties[${item.index}] without id requires value_type`,
            { field: `properties[${item.index}].value_type` },
          );
        }
        const createInput: NetworkPropertyInput = {
          name: item.name,
          value_type: item.value_type,
          ...(item.config !== undefined ? { config: item.config ?? null } : {}),
          ...(item.description !== undefined ? { description: item.description ?? null } : {}),
        };
        const created = createNetworkProperty(ndb, createInput, actorUserId);
        id = created.id;
        version = readVersion(ndb, 'properties', id);
        action = 'created';
      } else {
        const existing = getNetworkProperty(ndb, id);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `property ${id} not found`, {
            entity: 'property',
            id,
          });
        }
        const updateInput: NetworkPropertyUpdateInput = {};
        if (item.name !== '' && item.name !== existing.name) updateInput.name = item.name;
        if (item.value_type !== undefined && item.value_type !== existing.value_type) {
          updateInput.value_type = item.value_type;
          const counts = classifyStoredValues(ndb, id, existing.value_type, item.value_type);
          converted = counts.converted;
          dropped = counts.dropped;
        }
        if (
          item.config !== undefined &&
          JSON.stringify(item.config) !== JSON.stringify(existing.config)
        ) {
          updateInput.config = item.config ?? null;
        }
        if (item.description !== undefined && item.description !== existing.description) {
          updateInput.description = item.description ?? null;
        }
        if (Object.keys(updateInput).length > 0) {
          updateNetworkProperty(ndb, id, updateInput, actorUserId);
          version = readVersion(ndb, 'properties', id);
          action = 'updated';
        } else {
          version = readVersion(ndb, 'properties', id);
          action = 'unchanged';
        }
      }
      propResults.push({
        ref: item.ref,
        id,
        version,
        action,
        converted_values: converted,
        dropped_values: dropped,
      });
      if (item.ref !== null) propIdByRef.set(item.ref, id);
    }

    // ---- type_properties ----------------------------------------------
    // Все типы и свойства уже созданы — резолвим batch_ref → id.
    const resolvedTypeProperties = resolveTypeProperties(
      ndb,
      input.type_properties,
      ttRefs.definedRefs,
      ltRefs.definedRefs,
      pRefs.definedRefs,
    );
    const tpResults: OntologyWriteTypePropertyResult[] = [];
    for (const item of resolvedTypeProperties) {
      const typeId =
        item.typeRef.kind === 'existing' ? item.typeRef.id : (ttIdByRef.get(item.typeRef.ref) ?? ltIdByRef.get(item.typeRef.ref) ?? '');
      const propertyId =
        item.propertyRef.kind === 'existing'
          ? item.propertyRef.id
          : (propIdByRef.get(item.propertyRef.ref) ?? '');
      if (typeId === '' || propertyId === '') {
        throw new EtnError('VALIDATION_ERROR', 'type_ref or property_ref was not resolved', {
          field: `type_properties[${item.index}]`,
        });
      }
      const propRow = getNetworkProperty(ndb, propertyId);
      if (propRow === null) {
        throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
          entity: 'property',
          id: propertyId,
        });
      }
      const existing = getTypePropertyByKey(ndb, item.owner, typeId, propRow.name);
      let action: OntologyWriteTypePropertyResult['action'] = 'unchanged';
      let version = 0;
      let id = existing?.id ?? '';
      if (existing === null) {
        const created: PropertyDefinition = createTypeProperty(
          ndb,
          item.owner,
          typeId,
          {
            key: propRow.name,
            value_type: propRow.value_type,
            config: propRow.config,
            description: propRow.description,
            required: item.required,
            ...(item.position !== undefined ? { position: item.position } : {}),
          },
          actorUserId,
        );
        id = created.id;
        version = readVersion(ndb, 'type_properties', id);
        action = 'created';
      } else {
        const patch: { required?: boolean; position?: number } = {};
        if (item.required !== existing.required) patch.required = item.required;
        if (item.position !== undefined && item.position !== existing.position) {
          patch.position = item.position;
        }
        if (Object.keys(patch).length > 0) {
          updateTypeProperty(ndb, existing.id, patch, actorUserId);
          version = readVersion(ndb, 'type_properties', existing.id);
          action = 'updated';
        } else {
          version = readVersion(ndb, 'type_properties', existing.id);
          action = 'unchanged';
        }
      }
      tpResults.push({
        owner: item.owner,
        type_ref: item.type_ref,
        property_ref: item.property_ref,
        type_id: typeId,
        property_id: propertyId,
        id,
        version,
        action,
      });
    }

    // ---- type_views (задача c1fa71d4, 0.7.3) ------------------------
    // Отборы типов правятся той же транзакцией (ADR 5c44f6a7). Все типы
    // и свойства уже созданы — резолвим batch_ref → id. `ref_for_update`
    // (отбор, который в этом же батче создаётся/правится и на который
    // ссылается другой элемент) резолвится ниже отдельным проходом после
    // первой итерации `viewIdByRef`.
    const tvResults: OntologyWriteTypeViewResult[] = [];
    const viewIdByRef = new Map<string, string>();
    for (const item of resolvedTypeViews) {
      // Пропуск delete с нерезолвнутым id/ref_for_update — это пустой
      // проход, резолвится во втором.
      if (item.action === 'delete' && item.viewId === null && item.ref_for_update === null) {
        // Не должно случаться: resolveTypeViews уже валидирует. Но на
        // всякий случай — fail-safe: пропускаем до второго прохода.
        tvResults.push({
          ref: item.ref,
          id: '',
          thought_type_id: '',
          version: 0,
          action: 'unchanged',
        });
        continue;
      }
      const thoughtTypeId =
        item.thoughtTypeRef.kind === 'existing'
          ? item.thoughtTypeRef.id
          : (ttIdByRef.get(item.thoughtTypeRef.ref) ?? '');
      if (thoughtTypeId === '') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `thought_type_ref "${item.thoughtTypeRef.kind === 'batch_ref' ? item.thoughtTypeRef.ref : ''}" was not resolved`,
          { field: `type_views[${item.index}].thought_type_ref` },
        );
      }
      let id = '';
      let version = 0;
      let action: OntologyWriteTypeViewAction = 'unchanged';
      if (item.action === 'create') {
        if (item.name === undefined || item.definition === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `type_views[${item.index}] action=create requires name and definition`,
            { field: `type_views[${item.index}]` },
          );
        }
        const created = createThoughtTypeView(
          ndb,
          thoughtTypeId,
          {
            name: item.name,
            ...(item.description !== undefined ? { description: item.description } : {}),
            definition: item.definition,
            ...(item.position !== undefined ? { position: item.position } : {}),
            ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
          },
          actorUserId,
        );
        id = created.id;
        version = created.version;
        action = 'created';
      } else if (item.action === 'update') {
        if (item.viewId === null) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `type_views[${item.index}] action=update requires id or ref_for_update`,
            { field: `type_views[${item.index}]` },
          );
        }
        const updated = updateThoughtTypeView(
          ndb,
          item.viewId,
          {
            ...(item.name !== undefined ? { name: item.name } : {}),
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(item.definition !== undefined ? { definition: item.definition } : {}),
            ...(item.position !== undefined ? { position: item.position } : {}),
            ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
          },
          undefined,
          actorUserId,
        );
        id = updated.id;
        version = updated.version;
        action = 'updated';
      } else {
        // delete
        if (item.viewId === null) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `type_views[${item.index}] action=delete requires id or ref_for_update`,
            { field: `type_views[${item.index}]` },
          );
        }
        deleteThoughtTypeView(ndb, item.viewId);
        id = item.viewId;
        version = 0;
        action = 'deleted';
      }
      tvResults.push({
        ref: item.ref,
        id,
        thought_type_id: thoughtTypeId,
        version,
        action,
      });
      if (item.ref !== null) viewIdByRef.set(item.ref, id);
    }
    // Второй проход: резолв `ref_for_update` для тех, что зависят от id,
    // полученного в первом проходе (создание отбора в этом же батче).
    for (let i = 0; i < resolvedTypeViews.length; i += 1) {
      const item = resolvedTypeViews[i]!;
      if (item.ref_for_update === null) continue;
      const resolvedId = viewIdByRef.get(item.ref_for_update);
      if (resolvedId === undefined) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `ref_for_update "${item.ref_for_update}" не удалось разрешить в этом батче`,
          { field: `type_views[${item.index}].ref_for_update` },
        );
      }
      // Применяем операцию с подставленным id.
      const thoughtTypeId =
        item.thoughtTypeRef.kind === 'existing'
          ? item.thoughtTypeRef.id
          : (ttIdByRef.get(item.thoughtTypeRef.ref) ?? '');
      let id = '';
      let version = 0;
      let action: OntologyWriteTypeViewAction = 'unchanged';
      if (item.action === 'create') {
        const created = createThoughtTypeView(
          ndb,
          thoughtTypeId,
          {
            name: item.name as string,
            ...(item.description !== undefined ? { description: item.description } : {}),
            definition: item.definition as string,
            ...(item.position !== undefined ? { position: item.position } : {}),
            ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
          },
          actorUserId,
        );
        id = created.id;
        version = created.version;
        action = 'created';
      } else if (item.action === 'update') {
        const updated = updateThoughtTypeView(
          ndb,
          resolvedId,
          {
            ...(item.name !== undefined ? { name: item.name } : {}),
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(item.definition !== undefined ? { definition: item.definition } : {}),
            ...(item.position !== undefined ? { position: item.position } : {}),
            ...(item.is_default !== undefined ? { is_default: item.is_default } : {}),
          },
          undefined,
          actorUserId,
        );
        id = updated.id;
        version = updated.version;
        action = 'updated';
      } else {
        deleteThoughtTypeView(ndb, resolvedId);
        id = resolvedId;
        version = 0;
        action = 'deleted';
      }
      // Перезаписываем placeholder из первого прохода.
      const existing = tvResults[i]!;
      existing.id = id;
      existing.thought_type_id = thoughtTypeId;
      existing.version = version;
      existing.action = action;
      if (item.ref !== null) viewIdByRef.set(item.ref, id);
    }

    return {
      thought_types: ttResults,
      link_types: ltResults,
      properties: propResults,
      type_properties: tpResults,
      type_views: tvResults,
      layer: { id: ndb.layerId, title: '' },
    };
  });
}
