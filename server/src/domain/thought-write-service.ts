/**
 * Composite batch write service for `etn.thoughts.write` (task 053751b5,
 * версия 0.7.2, docs/05-mcp-server.md §4.2b).
 *
 * Пишет от 1 до {@link MCP_MAX_THOUGHTS_PER_WRITE} связанных единиц знания
 * одной SQL-транзакцией: мысли + их постоянные/хронологические комментарии +
 * свойства + связи (с их свойствами и комментариями) + вложения. Главный
 * пишущий инструмент ETN; поглощает `etn.thoughts.create`/`update`/
 * `set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`,
 * `etn.comments.upsert` — они удалены в 0.8.2 (задача 937480ca).
 *
 * Алгоритм — двухфазный внутри одной транзакции:
 *   1. **Resolve** — препроход по всем элементам батча с целью собрать
 *      карту `ref → thoughtId` и валидировать ссылки `target_ref` (неизвестный
 *      `target_ref` → `VALIDATION_ERROR` ДО первой записи, повторяющийся
 *      `ref` → `VALIDATION_ERROR`).
 *   2. **Write thoughts** — для каждого элемента создаётся (или
 *      переиспользуется/обновляется) мысль через {@link upsertThoughtBundle}
 *      с её собственным постоянным комментарием, хронологией, свойствами
 *      и вложениями. `ref` мапится на полученный `id`. Значения свойств,
 *      называющие локальный `ref` батча, откладываются до фазы 2.5 (цель
 *      может быть ещё не создана).
 *   2.5. **Deferred ref property values** — значения, равные объявленным `ref`,
 *      резолвятся в реальные id и пишутся здесь, когда все мысли батча уже
 *      имеют id (ошибка 93bc46bb). Свойство признаётся связью по тем же
 *      семантикам имён, что и фаза 2 (`resolveDefinition`).
 *   3. **Write links** — все связи с `target_id` (существующая) или
 *      `target_ref` (только что созданная) разрешаются в реальные id и
 *      пишутся пакетом.
 *
 * Циклы через `ref`/`target_ref` корректны: все мысли фазы 2 уже имеют
 * реальные id к моменту создания связей.
 *
 * Все ошибки (NOT_FOUND, DUPLICATE, VALIDATION_ERROR, …) внутри батча
 * откатывают ВЕСЬ вызов — вызывающий никогда не видит полузаписанный граф.
 */

import type {
  Comment,
  McpThoughtWriteItemResult,
  McpThoughtWriteLinkSpec,
  McpThoughtWriteParams,
  PropertyValue,
  PropertyValueValue,
  ThoughtBundleInput,
  MutationWarning,
} from '@etn/shared';
import { EtnError, MCP_MAX_THOUGHTS_PER_WRITE, isTransclusionLostWarning } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import type { CrossNetworkAccessContext } from './cross-network-ref-service.js';
import { upsertThoughtBundle } from './thought-bundle-service.js';
import { resolveThoughtTypeIdByName } from './thought-type-service.js';
import { resolveLinkTypeIdByName } from './link-type-service.js';
import { createLink } from './link-service.js';
import { listComments } from './comment-service.js';
import {
  computeThoughtCardWarnings,
  getPropertyValues,
  resolveDefinition,
  setPropertyValue,
} from './property-service.js';

export { EtnError, MCP_MAX_THOUGHTS_PER_WRITE };

/** Per-batch write input — exact mirror of {@link McpThoughtWriteParams}. */
export type ThoughtWriteInput = McpThoughtWriteParams;

/** Per-item write outcome; same shape as {@link McpThoughtWriteItemResult}. */
export type ThoughtWriteItemResult = McpThoughtWriteItemResult;

/** Whole-batch result. */
export interface ThoughtWriteResult {
  items: ThoughtWriteItemResult[];
  /** Aggregated non-fatal warnings across the batch (one per item, with
   *  `ref`/`thought_id` so the caller can locate the offender). Card-completeness
   *  warnings are recomputed against the final card; transclusion-loss warnings
   *  (требование 822a9149) are preserved as-is. */
  warnings: MutationWarning[];
  /** Total link count actually written (created). */
  link_count: number;
  /** Total thought count actually affected (created + updated). */
  thought_count: number;
}

/** Validate the batch envelope before any work happens (cheap). */
function validateEnvelope(input: ThoughtWriteInput): void {
  if (input.thoughts.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'thoughts[] must contain at least one item', {
      field: 'thoughts',
    });
  }
  if (input.thoughts.length > MCP_MAX_THOUGHTS_PER_WRITE) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `thoughts[] exceeds the per-batch limit of ${MCP_MAX_THOUGHTS_PER_WRITE}`,
      {
        field: 'thoughts',
        limit: MCP_MAX_THOUGHTS_PER_WRITE,
        actual: input.thoughts.length,
      },
    );
  }
  // Phase 1: uniqueness of `ref` + XOR thought_id/thought. Also collect
  // the set of declared refs so phase 2 can validate `target_ref` early.
  // `local_refs` keys participate in the same namespace — duplicates with
  // `thoughts[].ref` are rejected here so phase 2 can trust the set.
  const seenRefs = new Set<string>();
  if (input.local_refs !== undefined) {
    for (const name of Object.keys(input.local_refs)) {
      if (name === '') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'local_refs keys must be non-empty strings',
          { field: 'local_refs' },
        );
      }
      if (seenRefs.has(name)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `duplicate ref in batch: "${name}" is both a local_ref and a thought.ref`,
          { field: 'local_refs', ref: name },
        );
      }
      seenRefs.add(name);
    }
  }
  for (const [index, item] of input.thoughts.entries()) {
    const hasThoughtId = item.thought_id !== undefined;
    const hasThought = item.thought !== undefined;
    if (hasThoughtId === hasThought) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'each batch item must set exactly one of thought_id or thought',
        { field: `thoughts[${index}]`, has_thought_id: hasThoughtId, has_thought: hasThought },
      );
    }
    if (hasThought && !hasThoughtId && item.ref === undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'a batch item with `thought` (new thought) must also declare a local `ref`',
        { field: `thoughts[${index}]` },
      );
    }
    // Item-level `title`/`synonyms`/`type_id`/`type` patch an EXISTING thought
    // (addressed by `thought_id`) and are not read for a new `thought` — the
    // domain would silently ignore them (bug 21cbafb8). Reject them here too,
    // so the guard holds regardless of the caller layer. Item-level `active`
    // stays valid for a new thought: it is applied to it.
    if (hasThought) {
      for (const field of ['title', 'synonyms', 'type_id', 'type'] as const) {
        if (item[field] !== undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `item-level \`${field}\` applies only to an existing thought addressed by ` +
              `thought_id; for a new thought set it inside the \`thought\` block ` +
              `(thought.${field})`,
            { field: `thoughts[${index}].${field}` },
          );
        }
      }
    }
    if (item.ref !== undefined) {
      if (item.ref === '') {
        throw new EtnError('VALIDATION_ERROR', 'ref must be a non-empty string', {
          field: `thoughts[${index}].ref`,
        });
      }
      if (seenRefs.has(item.ref)) {
        throw new EtnError('VALIDATION_ERROR', 'duplicate ref in batch', {
          field: `thoughts[${index}].ref`,
          ref: item.ref,
        });
      }
      seenRefs.add(item.ref);
    }
  }
}

/**
 * Resolve every `thoughts[]` item's type by name → id and every
 * `links[].type` by name → id, raising `VALIDATION_ERROR` for missing
 * types (унаследовано от удалённых в 0.8.2 `etn.thoughts.create` / `etn.thoughts.upsert_bundle`).
 */
function resolveTypes(ndb: NetworkDb, input: ThoughtWriteInput): ThoughtWriteInput {
  return {
    network_id: input.network_id,
    ...(input.local_refs === undefined ? {} : { local_refs: input.local_refs }),
    thoughts: input.thoughts.map((item) => {
      const thought =
        item.thought === undefined
          ? undefined
          : {
              ...item.thought,
              ...(item.thought.type_id === undefined && item.thought.type !== undefined
                ? { type_id: resolveThoughtTypeIdByName(ndb, item.thought.type) }
                : {}),
            };
      // Item-level `type` (XOR `type_id`, bug 870c0c0d): тип существующей
      // мысли, адресованной `thought_id`, тоже задаётся по имени.
      const itemTypeId =
        item.type_id === undefined && item.type !== undefined
          ? resolveThoughtTypeIdByName(ndb, item.type)
          : undefined;
      const links =
        item.links === undefined
          ? undefined
          : item.links.map((l) => {
              let typeId: string | null | undefined = l.type_id;
              if (typeId === undefined && l.type !== undefined) {
                typeId = resolveLinkTypeIdByName(ndb, l.type);
              }
              return {
                ...l,
                ...(typeId === undefined ? {} : { type_id: typeId }),
              };
            });
      return {
        ...item,
        ...(thought === undefined ? {} : { thought }),
        ...(itemTypeId === undefined ? {} : { type_id: itemTypeId }),
        ...(links === undefined ? {} : { links }),
      };
    }),
  };
}

/** Pre-resolve `thought_id`-addressed items so `target_ref` can resolve to
 *  an existing thought across the batch even when it's addressed by id.
 *  `local_refs` aliases are also seeded here — they name existing thoughts by
 *  uuid so phase 3 can resolve `target_ref` to the right id. */
function resolveExistingThoughtIds(input: ThoughtWriteInput): Map<string, string> {
  const map = new Map<string, string>();
  if (input.local_refs !== undefined) {
    for (const [name, thoughtId] of Object.entries(input.local_refs)) {
      map.set(name, thoughtId);
    }
  }
  for (const item of input.thoughts) {
    if (item.ref !== undefined && item.thought_id !== undefined) {
      map.set(item.ref, item.thought_id);
    }
  }
  return map;
}

/**
 * Every local name declared in the batch: `local_refs` keys plus
 * `thoughts[].ref`. Used both to validate `links[].target_ref` before any write
 * and to spot link-property values that name a batch ref instead of a real id
 * (ошибка 93bc46bb).
 */
function collectDeclaredRefs(input: ThoughtWriteInput): Set<string> {
  const declaredRefs = new Set<string>();
  if (input.local_refs !== undefined) {
    for (const name of Object.keys(input.local_refs)) declaredRefs.add(name);
  }
  for (const item of input.thoughts) {
    if (item.ref !== undefined) declaredRefs.add(item.ref);
  }
  return declaredRefs;
}

/**
 * `true` when a property value names any ref declared in this batch (a single
 * string, or one of the strings of a multi-value / link set). Such a value is
 * a local `ref`, not a real id — it must be resolved on the same phase as
 * `links[].target_ref` (ошибка 93bc46bb), never written verbatim.
 */
function valueReferencesDeclaredRef(
  value: PropertyValueValue,
  declaredRefs: Set<string>,
): boolean {
  if (typeof value === 'string') return declaredRefs.has(value);
  if (Array.isArray(value)) {
    return value.some((v) => typeof v === 'string' && declaredRefs.has(v));
  }
  return false;
}

/**
 * Replace every string of a property value that names a resolved batch ref with
 * its real thought id; other values (real ids, scalars, cross-network objects)
 * pass through untouched.
 */
function resolveRefValue(
  value: PropertyValueValue,
  refToId: Map<string, string>,
): PropertyValueValue {
  if (typeof value === 'string') return refToId.get(value) ?? value;
  if (Array.isArray(value)) {
    // Only a pure string set can name batch refs; a `cross_network_ref` set is
    // addressed by cross-network objects and passes through untouched.
    if (value.every((v): v is string => typeof v === 'string')) {
      return value.map((v) => refToId.get(v) ?? v);
    }
    return value;
  }
  return value;
}

/**
 * Split each item's `properties` into those written on phase 2 (as before) and
 * those whose value names a batch `ref` — the latter cannot be written before
 * the referenced thought exists, so they are deferred to phase 2.5, once every
 * thought has a real id (ошибка 93bc46bb).
 *
 * The split deliberately does NOT decide whether a property is a link property:
 * phase 2 accepts a link property by canonical registry name AND by the display
 * name of EITHER side of its binding (paths 1 and 3 of `resolveDefinition`),
 * and that resolution needs the owner — which does not exist yet. So any value
 * naming a declared ref is deferred; phase 2.5 then asks `resolveDefinition`
 * the same question phase 2 would and resolves the ref only for
 * `value_type: 'link'` (a scalar whose text equals a ref name is written
 * verbatim). A key unknown to the registry stays deferred too and raises the
 * usual `NOT_FOUND` from `setPropertyValue` in phase 2.5.
 */
function splitRefPropertyValues(
  input: ThoughtWriteInput,
  declaredRefs: Set<string>,
): {
  kept: Array<Record<string, PropertyValueValue> | undefined>;
  deferred: Array<Record<string, PropertyValueValue> | undefined>;
} {
  const kept: Array<Record<string, PropertyValueValue> | undefined> = [];
  const deferred: Array<Record<string, PropertyValueValue> | undefined> = [];
  for (const item of input.thoughts) {
    if (item.properties === undefined) {
      kept.push(undefined);
      deferred.push(undefined);
      continue;
    }
    let keptHere: Record<string, PropertyValueValue> | undefined;
    let deferredHere: Record<string, PropertyValueValue> | undefined;
    for (const [key, value] of Object.entries(item.properties)) {
      if (valueReferencesDeclaredRef(value, declaredRefs)) {
        deferredHere ??= {};
        deferredHere[key] = value;
        continue;
      }
      keptHere ??= {};
      keptHere[key] = value;
    }
    kept.push(keptHere);
    deferred.push(deferredHere);
  }
  return { kept, deferred };
}

/**
 * Validate `links[].target_id` / `target_ref` XOR and check `target_ref`
 * resolves to a ref declared elsewhere in the batch. The `refToId` map is
 * seeded from `thought_id`-addressed items so cross-batch references to
 * existing thoughts work; `target_ref`s to `thought`-addressed items are
 * validated against the union of declared refs (built here) so a link from
 * item 0 to item 1's ref is OK even though item 1 hasn't been written yet.
 */
function validateLinkTargets(input: ThoughtWriteInput, refToId: Map<string, string>): void {
  // All declared refs in this batch — used to validate `target_ref` before
  // any item has been written. Empty refs (items with no `ref`) are ignored.
  // `local_refs` keys are also "declared" — the user named them on purpose
  // and the corresponding uuid sits in `refToId`.
  const declaredRefs = collectDeclaredRefs(input);
  for (const [index, item] of input.thoughts.entries()) {
    if (item.links === undefined) continue;
    for (const [linkIndex, link] of item.links.entries()) {
      const hasId = link.target_id !== undefined;
      const hasRef = link.target_ref !== undefined;
      if (hasId === hasRef) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'each links[] entry must set exactly one of target_id or target_ref',
          {
            field: `thoughts[${index}].links[${linkIndex}]`,
            has_target_id: hasId,
            has_target_ref: hasRef,
          },
        );
      }
      if (hasRef) {
        const refName = link.target_ref as string;
        const isDeclared = declaredRefs.has(refName);
        const isExisting = refToId.has(refName);
        if (!isDeclared && !isExisting) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `target_ref "${refName}" is not declared in this batch`,
            {
              field: `thoughts[${index}].links[${linkIndex}].target_ref`,
              target_ref: refName,
              known_refs: Array.from(declaredRefs),
            },
          );
        }
      }
    }
  }
}

/**
 * Run a `etn.thoughts.write` batch.
 *
 * Алгоритм в три фазы внутри ОДНОЙ SQLite-транзакции:
 *   1. **Validate** — конверт (XOR, уникальные `ref`, лимит `thoughts[]`,
 *      `target_ref` ссылается на объявленный или уже существующий `ref`).
 *      ДО первой записи.
 *   2. **Thoughts** — для каждого элемента создаём/обновляем/переиспользуем
 *      мысль через {@link upsertThoughtBundle} БЕЗ связей (комментарий,
 *      хронология, свойства, вложения — идут в комплекте). `ref → id`
 *      собирается параллельно. Значения свойств, называющие `ref`, отложены.
 *   2.5. **Deferred ref property values** — значения, равные объявленным
 *      `ref`, резолвятся в id и пишутся (все мысли уже созданы).
 *   3. **Links** — резолвим `target_ref` в реальные id (все мысли уже
 *      имеют id к этому моменту, циклы корректны), создаём связи
 *      пакетом. Знание на связи (`links[].properties`, `links[].comment`)
 *      пишется в той же фазе — это часть {@link createLink}.
 *
 * Любая ошибка внутри `ndb.transaction` откатывает ВСЁ — вызывающий
 * никогда не видит полузаписанный граф.
 *
 * `crossNetworkAccess` (задача 7849008a) — опциональный контекст для значений
 * вида `cross_network_ref` в `item.properties`: без него такая запись
 * отвергается (`INTERNAL`), с ним идёт штатный живой резолв цели. MCP-фасад
 * (`etn.thoughts.write`) строит его из runtime
 * ({@link import('../mcp/context.js').mcpCrossNetworkAccess}); REST — из
 * запроса.
 */
export function writeThoughts(
  ndb: NetworkDb,
  input: ThoughtWriteInput,
  actorUserId: string,
  crossNetworkAccess?: CrossNetworkAccessContext,
): ThoughtWriteResult {
  validateEnvelope(input);
  const resolved = resolveTypes(ndb, input);
  // Seed the ref map with thought_id-addressed items so cross-batch
  // target_ref references to those ids resolve during phase 3.
  const refToId = resolveExistingThoughtIds(resolved);
  const declaredRefs = collectDeclaredRefs(resolved);
  validateLinkTargets(resolved, refToId);
  // Property values that name a batch `ref` cannot be written on phase 2 (the
  // target may not exist yet) — they join phase 2.5, once every thought has a
  // real id. Whether such a value IS a link property is decided there by the
  // same `resolveDefinition` semantics phase 2 uses (ошибка 93bc46bb).
  const { kept: keptProperties, deferred: deferredProperties } = splitRefPropertyValues(
    resolved,
    declaredRefs,
  );

  return ndb.transaction(() => {
    const items: ThoughtWriteItemResult[] = [];
    let linkCount = 0;
    const warnings: MutationWarning[] = [];
    /** Spec links per item, indexed by batch position. Filled during phase 2
     *  and consumed by phase 3 — needs to be in a closure-scoped array so
     *  the link-writing pass can walk it AFTER phase 2 has populated refToId. */
    const pendingLinks: Array<{
      itemIndex: number;
      itemRef: string | null;
      itemThoughtId: string;
      links: McpThoughtWriteLinkSpec[] | undefined;
    }> = [];

    // ---- phase 2: create or patch each thought (without links) ------------
    for (const [index, item] of resolved.thoughts.entries()) {
      // Strip ref AND links — we persist thoughts + comments + chronicle +
      // properties + attachments here, then write links in phase 3 once all
      // thoughts have real ids (handles forward refs and cycles cleanly).
      const bundleInput: ThoughtBundleInput = {
        ...(item.thought_id !== undefined ? { thought_id: item.thought_id } : {}),
        ...(item.thought !== undefined ? { thought: item.thought } : {}),
        ...(item.active !== undefined ? { active: item.active } : {}),
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.synonyms !== undefined ? { synonyms: item.synonyms } : {}),
        ...(item.type_id !== undefined ? { type_id: item.type_id } : {}),
        ...(item.on_duplicate !== undefined ? { on_duplicate: item.on_duplicate } : {}),
        ...(item.comment === undefined ? {} : { comment: item.comment }),
        ...(item.chronicle === undefined ? {} : { chronicle: item.chronicle }),
        ...(keptProperties[index] === undefined ? {} : { properties: keptProperties[index] }),
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
      };

      const result = upsertThoughtBundle(ndb, bundleInput, actorUserId, crossNetworkAccess);

      // Fill the ref map AFTER creation so a later batch item can target_ref
      // this one.
      if (item.ref !== undefined) {
        refToId.set(item.ref, result.thought.id);
      }

      const itemWarnings = result.warnings ?? [];
      warnings.push(
        ...itemWarnings.map((w) => ({
          ...w,
          ...(item.ref !== undefined ? { ref: item.ref } : {}),
          ...(item.thought_id !== undefined ? { thought_id: item.thought_id } : {}),
        })),
      );

      // Save links for phase 3 (need real ids).
      pendingLinks.push({
        itemIndex: index,
        itemRef: item.ref ?? null,
        itemThoughtId: result.thought.id,
        links: item.links,
      });

      items.push({
        ref: item.ref ?? null,
        thought_id: item.thought_id ?? null,
        id: result.thought.id,
        version: result.thought.version,
        thought_action: result.thought_action,
        matched_on: result.matched_on,
        // Non-blocking duplicate candidates for a created thought (задача
        // bf9f46bd): partial/wildcard/different-type matches no longer refuse
        // creation — they tail the item result instead.
        ...(result.duplicate_candidates !== undefined
          ? { duplicate_candidates: result.duplicate_candidates }
          : {}),
        ...(result.comment !== undefined
          ? {
              comment: {
                id: result.comment.id,
                version: result.comment.version,
                action: (result.comment_action ?? 'created') as 'created' | 'updated',
              },
            }
          : {}),
        ...(result.chronicle !== undefined
          ? {
              chronicle: result.chronicle.map((c: Comment) => ({
                id: c.id,
                version: c.version,
              })),
            }
          : {}),
        ...(result.properties !== undefined
          ? {
              properties: Object.fromEntries(
                Object.entries(result.properties).map(([key, v]: [string, PropertyValue]) => [
                  key,
                  // Свойство-связь — проекция рёбер: строки `property_values`
                  // нет (`id: null`), но эхо несёт ИТОГОВЫЙ набор целей —
                  // иначе `{id: null}` не давал убедиться, что рёбра встали
                  // (ошибка 17cc0d54).
                  v.value_type === 'link'
                    ? {
                        id: null,
                        targets: linkTargetIds(v.value),
                        ...(v.link_ids !== undefined && v.link_ids.length > 0
                          ? { link_ids: v.link_ids }
                          : {}),
                      }
                    : { id: v.id },
                ]),
              ),
            }
          : {}),
        // `links` filled in phase 3 below — we still want a placeholder so
        // the array order matches the request when the agent reads items[].
        links: [],
        // Рёбра link-дефолтов типа при создании мысли — по ним фасад
        // публикует `link.created` (ошибка 8655842b).
        ...(result.default_link_ids !== undefined
          ? { default_link_ids: result.default_link_ids }
          : {}),
        ...(result.attachments !== undefined && result.attachments.length > 0
          ? { attachments: result.attachments.map((a) => ({ id: a.id })) }
          : {}),
        warnings: itemWarnings,
      });
    }

    // ---- phase 2.5: deferred ref property values ---------------------------
    // Every thought now has a real id, so a property addressed by ANY name the
    // read side shows (canonical registry name, or the display name of either
    // side of a link property — same `resolveDefinition` semantics as phase 2)
    // can be recognised and, when it is a link property, have its `ref` values
    // resolved exactly like `links[].target_ref` (ошибка 93bc46bb). A scalar
    // whose text merely equals a ref name is written verbatim.
    for (const [index, deferred] of deferredProperties.entries()) {
      if (deferred === undefined) continue;
      const itemResult = items[index];
      if (itemResult === undefined) continue;
      for (const [key, rawValue] of Object.entries(deferred)) {
        const def = resolveDefinition(ndb, 'thought', itemResult.id, key);
        const value =
          def?.value_type === 'link' ? resolveRefValue(rawValue, refToId) : rawValue;
        const pv = setPropertyValue(
          ndb,
          'thought',
          itemResult.id,
          key,
          value,
          actorUserId,
          crossNetworkAccess,
        );
        // Merge into the item echo with the same projection phase 2 uses, so
        // `link_ids` still feed `link.created` publication in the facade.
        itemResult.properties = {
          ...(itemResult.properties ?? {}),
          [key]:
            pv.value_type === 'link'
              ? {
                  id: null,
                  targets: linkTargetIds(pv.value),
                  ...(pv.link_ids !== undefined && pv.link_ids.length > 0
                    ? { link_ids: pv.link_ids }
                    : {}),
                }
              : { id: pv.id },
        };
      }
    }

    // ---- phase 3: materialize links ---------------------------------------
    // All thoughts have real ids now (forward refs to items later in the
    // batch resolve correctly), so each `target_ref` translates to a real
    // target_id. createLink itself writes properties + permanent comment
    // in the same transaction arm — failures roll back the whole batch.
    for (const pending of pendingLinks) {
      if (pending.links === undefined || pending.links.length === 0) continue;
      const itemResult = items[pending.itemIndex];
      if (itemResult === undefined) continue;
      for (const linkSpec of pending.links) {
        const targetId = linkSpec.target_id ?? refToId.get(linkSpec.target_ref as string);
        if (targetId === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `target_ref "${linkSpec.target_ref as string}" was not resolved before link write`,
            { ref: linkSpec.target_ref },
          );
        }
        const [sourceId, actualTargetId] =
          linkSpec.direction === 'parent'
            ? [targetId, pending.itemThoughtId]
            : [pending.itemThoughtId, targetId];

        const linkWarnings: MutationWarning[] = [];
        const lr = createLink(
          ndb,
          {
            source_id: sourceId,
            target_id: actualTargetId,
            type_id: linkSpec.type_id ?? null,
            ...(linkSpec.properties !== undefined ? { properties: linkSpec.properties } : {}),
            ...(linkSpec.comment !== undefined ? { comment: linkSpec.comment } : {}),
          },
          actorUserId,
          // Комментарий ребра — markdown-поле: восстановление ребра из корзины
          // с новым комментарием может потерять трансклюзии (требование
          // 822a9149). Предупреждение уходит в warnings элемента и батча.
          { warnings: linkWarnings },
        );
        if (linkWarnings.length > 0) itemResult.warnings.push(...linkWarnings);

        // Read back inline knowledge attached to the link so the caller sees
        // the full picture (same trick as upsertThoughtBundle).
        let writtenProps: Record<string, PropertyValue> | undefined;
        let writtenComment: Comment | undefined;
        if (linkSpec.properties !== undefined && Object.keys(linkSpec.properties).length > 0) {
          const all = getPropertyValues(ndb, 'link', lr.id);
          writtenProps = {};
          for (const key of Object.keys(linkSpec.properties)) {
            const found = all.find((pv) => pv.property_name === key);
            if (found !== undefined) writtenProps[key] = found;
          }
        }
        if (linkSpec.comment !== undefined) {
          const permanent = listComments(ndb, 'link', lr.id).find((c) => c.kind === 'permanent');
          writtenComment = permanent;
        }

        itemResult.links!.push({
          id: lr.id,
          version: lr.version,
          ...(writtenProps !== undefined
            ? {
                properties: Object.fromEntries(
                  Object.entries(writtenProps).map(([key, v]: [string, PropertyValue]) => [
                    key,
                    { id: v.id },
                  ]),
                ),
              }
            : {}),
          ...(writtenComment !== undefined
            ? { comment: { id: writtenComment.id, version: writtenComment.version } }
            : {}),
        });
        linkCount += 1;
      }
    }

    // Phase 2 computed card warnings BEFORE phase 3 materialized the top-level
    // `links[]` (upsertThoughtBundle does not see them), so a required
    // link-property filled by an edge of the same batch kept a false
    // `REQUIRED_PROPERTY_MISSING` (ошибка 6f5812a3). Recompute warnings against
    // the FINAL card state once every link exists — this also refreshes the
    // aggregated `warnings[]` so batch-level consumers see the same picture.
    if (
      deferredProperties.some((d) => d !== undefined) ||
      pendingLinks.some((p) => p.links !== undefined && p.links.length > 0)
    ) {
      warnings.length = 0;
      for (const [index, it] of items.entries()) {
        // Свежие карточные предупреждения + сохранённые предупреждения о
        // потере трансклюзий (требование 822a9149): пересчёт карточки не должен
        // стирать предупреждение о текстовой записи.
        const textLost = it.warnings.filter(isTransclusionLostWarning);
        const fresh: MutationWarning[] = [...computeThoughtCardWarnings(ndb, it.id), ...textLost];
        it.warnings = fresh;
        const source = resolved.thoughts[index]!;
        warnings.push(
          ...fresh.map((w) => ({
            ...w,
            ...(source.ref !== undefined ? { ref: source.ref } : {}),
            ...(source.thought_id !== undefined ? { thought_id: source.thought_id } : {}),
          })),
        );
      }
    }

    // `thought_count` mirrors how many items had a mutation (created or
    // updated) — `reused` items aren't counted because the batch didn't
    // change them, but the agent still gets the `thought_action` per item.
    const thoughtCount = items.reduce(
      (acc, it) => acc + (it.thought_action === 'reused' ? 0 : 1),
      0,
    );

    return { items, warnings, link_count: linkCount, thought_count: thoughtCount };
  });
}

/**
 * Нормализовать значение свойства-связи в список id целей для эха ответа
 * `etn.thoughts.write` (ошибка 17cc0d54): `setPropertyValue` отдаёт для связи
 * одиночный id или массив — приводим к массиву, чтобы форма ответа была
 * предсказуемой.
 */
function linkTargetIds(value: PropertyValueValue): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}
