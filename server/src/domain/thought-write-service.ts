/**
 * Composite batch write service for `etn.thoughts.write` (task 053751b5,
 * версия 0.7.2, docs/05-mcp-server.md §4.2b).
 *
 * Пишет от 1 до {@link MCP_MAX_THOUGHTS_PER_WRITE} связанных единиц знания
 * одной SQL-транзакцией: мысли + их постоянные/хронологические комментарии +
 * свойства + связи (с их свойствами и комментариями) + вложения. Главный
 * пишущий инструмент ETN; поглощает `etn.thoughts.create`/`update`/
 * `set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`,
 * `etn.comments.upsert` — они помечены `deprecated_since: '0.7.2'`.
 *
 * Алгоритм — двухфазный внутри одной транзакции:
 *   1. **Resolve** — препроход по всем элементам батча с целью собрать
 *      карту `ref → thoughtId` и валидировать ссылки `target_ref` (неизвестный
 *      `target_ref` → `VALIDATION_ERROR` ДО первой записи, повторяющийся
 *      `ref` → `VALIDATION_ERROR`).
 *   2. **Write thoughts** — для каждого элемента создаётся (или
 *      переиспользуется/обновляется) мысль через {@link upsertThoughtBundle}
 *      с её собственным постоянным комментарием, хронологией, свойствами
 *      и вложениями. `ref` мапится на полученный `id`.
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
  ThoughtBundleInput,
  ThoughtCardWarning,
} from '@etn/shared';
import { EtnError, MCP_MAX_THOUGHTS_PER_WRITE } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { upsertThoughtBundle } from './thought-bundle-service.js';
import { resolveThoughtTypeIdByName } from './thought-type-service.js';
import { resolveLinkTypeIdByName } from './link-type-service.js';
import { createLink } from './link-service.js';
import { listComments } from './comment-service.js';
import { getPropertyValues } from './property-service.js';

export { EtnError, MCP_MAX_THOUGHTS_PER_WRITE };

/** Per-batch write input — exact mirror of {@link McpThoughtWriteParams}. */
export type ThoughtWriteInput = McpThoughtWriteParams;

/** Per-item write outcome; same shape as {@link McpThoughtWriteItemResult}. */
export type ThoughtWriteItemResult = McpThoughtWriteItemResult;

/** Whole-batch result. */
export interface ThoughtWriteResult {
  items: ThoughtWriteItemResult[];
  /** Aggregated card-completeness warnings across the batch (one per item,
   *  with `ref`/`thought_id` so the caller can locate the offender). */
  warnings: ThoughtCardWarning[];
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
  const seenRefs = new Set<string>();
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
 * types (mirrors `etn.thoughts.create` / `etn.thoughts.upsert_bundle`).
 */
function resolveTypes(ndb: NetworkDb, input: ThoughtWriteInput): ThoughtWriteInput {
  return {
    network_id: input.network_id,
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
        ...(links === undefined ? {} : { links }),
      };
    }),
  };
}

/** Pre-resolve `thought_id`-addressed items so `target_ref` can resolve to
 *  an existing thought across the batch even when it's addressed by id. */
function resolveExistingThoughtIds(input: ThoughtWriteInput): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of input.thoughts) {
    if (item.ref !== undefined && item.thought_id !== undefined) {
      map.set(item.ref, item.thought_id);
    }
  }
  return map;
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
  const declaredRefs = new Set<string>();
  for (const item of input.thoughts) {
    if (item.ref !== undefined) declaredRefs.add(item.ref);
  }
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
 *      собирается параллельно.
 *   3. **Links** — резолвим `target_ref` в реальные id (все мысли уже
 *      имеют id к этому моменту, циклы корректны), создаём связи
 *      пакетом. Знание на связи (`links[].properties`, `links[].comment`)
 *      пишется в той же фазе — это часть {@link createLink}.
 *
 * Любая ошибка внутри `ndb.transaction` откатывает ВСЁ — вызывающий
 * никогда не видит полузаписанный граф.
 */
export function writeThoughts(
  ndb: NetworkDb,
  input: ThoughtWriteInput,
  actorUserId: string,
): ThoughtWriteResult {
  validateEnvelope(input);
  const resolved = resolveTypes(ndb, input);
  // Seed the ref map with thought_id-addressed items so cross-batch
  // target_ref references to those ids resolve during phase 3.
  const refToId = resolveExistingThoughtIds(resolved);
  validateLinkTargets(resolved, refToId);

  return ndb.transaction(() => {
    const items: ThoughtWriteItemResult[] = [];
    let linkCount = 0;
    const warnings: ThoughtCardWarning[] = [];
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
        ...(item.on_duplicate !== undefined ? { on_duplicate: item.on_duplicate } : {}),
        ...(item.comment === undefined ? {} : { comment: item.comment }),
        ...(item.chronicle === undefined ? {} : { chronicle: item.chronicle }),
        ...(item.properties === undefined ? {} : { properties: item.properties }),
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
      };

      const result = upsertThoughtBundle(ndb, bundleInput, actorUserId);

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
                  { id: v.id },
                ]),
              ),
            }
          : {}),
        // `links` filled in phase 3 below — we still want a placeholder so
        // the array order matches the request when the agent reads items[].
        links: [],
        ...(result.attachments !== undefined && result.attachments.length > 0
          ? { attachments: result.attachments.map((a) => ({ id: a.id })) }
          : {}),
        warnings: itemWarnings,
      });
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
        );

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
