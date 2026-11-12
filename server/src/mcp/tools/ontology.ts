/**
 * ontology.ts — MCP-инструменты области «registerOntologyTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type {
  OntologyWriteParams,
  OntologyWriteResult,
} from '@etn/shared';
import {
  getLinkPropertyByLinkTypeId,
  getNetworkProperty,
  getTypeProperty,
} from '../../domain/property-service.js';
import { OntologyWrite } from '../../contracts.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { getLinkType } from '../../domain/link-type-service.js';
import { writeOntology } from '../../domain/ontology-write-service.js';
import {
  getThoughtTypeView,
  toEffectiveTypeView,
} from '../../domain/thought-type-views-service.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runWrite,
  runWriteTool,
} from '../context.js';

export function registerOntologyTools(mcp: McpServer, rt: McpRuntime): void {
  // `type_views[]` (задача c1fa71d4, 0.7.3, ADR 5c44f6a7). Правка отборов
  // идёт тем же батчем онтологии: `action: create|update|delete`,
  // `thought_type` XOR `thought_type_ref`, `id` XOR `ref_for_update` для
  // update/delete.
  mcp.registerTool(
    'etn.ontology.write',
    {
      title: 'Ontology batch write',
      description:
        'Idempotent upsert of the network ontology in one transaction across five sections: `thought_types[]` / ' +
        '`link_types[]` / `properties[]` / `type_properties[]` / `type_views[]`; upsert by `id` XOR ' +
        'name, local `ref`s work only inside the batch. Creating a link type in `link_types[]` also creates ' +
        'its paired link property in the same transaction (otherwise such a type is not editable in the GUI); ' +
        'the property id is returned as `property_id`. A name clash with an existing property, or a second ' +
        'link property for the same type, is `DUPLICATE`. One write budget + one ' +
        '`audit_log` row per call; real-time events — one per changed entity. An unknown ' +
        'top-level key → `VALIDATION_ERROR` (`details.fields`). Section details, `value_type` ' +
        'conversion, the unified link property ↔ link_type lifecycle and parent-change rules — ' +
        '`etn.guide { topic: "ontology.write" }`.',
      inputSchema: OntologyWrite.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ontology.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const writeInput: OntologyWriteParams = {
          network_id: args.network_id,
          ...(args.thought_types !== undefined ? { thought_types: args.thought_types } : {}),
          ...(args.link_types !== undefined ? { link_types: args.link_types } : {}),
          ...(args.properties !== undefined ? { properties: args.properties } : {}),
          ...(args.type_properties !== undefined ? { type_properties: args.type_properties } : {}),
          ...(args.type_views !== undefined ? { type_views: args.type_views } : {}),
        };
        const result = runWrite(ndb, fx, () => {
          // Снапшоты отборов, удаляемых батчем по явному `id` (0.14.1, ошибка
          // 69aa355c): после `writeOntology` строк уже нет. Для удаления через
          // `ref_for_update` карточки ДО удаления нет — событие уйдёт без
          // `view` (поле необязательное; клиент перечитает по `view_id`).
          const deletedViewSnapshots = new Map<
            string,
            ReturnType<typeof toEffectiveTypeView>
          >();
          for (const item of args.type_views ?? []) {
            if (item.action !== 'delete' || item.id === undefined) continue;
            const view = getThoughtTypeView(ndb, item.id);
            if (view !== null) deletedViewSnapshots.set(item.id, toEffectiveTypeView(view));
          }
          // Ошибка 117a999a: переименование типа связи переносит имя его
          // парного свойства (`syncLinkPropertyName`), но это отдельная
          // сущность реестра — подписчики `property-registry.*` должны узнать
          // об этом. Имена пар снимаем ДО записи: событие уходит только при
          // фактической смене имени, а не на идемпотентной перезаписи.
          const pairNamesBefore = new Map<string, string>();
          for (const item of args.link_types ?? []) {
            if (item.id === undefined || item.id === null) continue;
            if (item.name_forward === undefined && item.name_reverse === undefined) continue;
            const pair = getLinkPropertyByLinkTypeId(ndb, item.id);
            if (pair !== null) pairNamesBefore.set(pair.id, pair.name);
          }
          const written = writeOntology(ndb, writeInput, rt.deps.auth.userId);

          // Real-time + activity log: по одной записи на изменённую сущность.
          // События и журнал собираются из результата записи и исполняются
          // обёрткой после коммита.
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
          /** Парные свойства, переименованные вслед за типом связи. */
          let linkPropertiesRenamed = 0;
          for (const item of written.thought_types) {
            if (item.action === 'unchanged') continue;
            // After create/update — read back the type for the snapshot.
            const thoughtType = getThoughtType(ndb, item.id);
            if (thoughtType === null) continue;
            if (item.action === 'created') {
              events.push({ type: 'thought-type.created', data: { type: thoughtType } });
              activity.push({ kind: 'thought-type', action: 'created', type: thoughtType });
            } else {
              events.push({
                type: 'thought-type.updated',
                data: { id: item.id, version: item.version, changes: {} },
              });
            }
          }
          for (const item of written.link_types) {
            if (item.action === 'unchanged') continue;
            const linkType = getLinkType(ndb, item.id);
            if (linkType === null) continue;
            if (item.action === 'created') {
              events.push({ type: 'link-type.created', data: { type: linkType } });
              activity.push({ kind: 'link-type', action: 'created', type: linkType });
              // Ошибка 117a999a: создание типа секцией `link_types[]` создаёт
              // парное свойство-связь — отдельная изменённая сущность, клиенты
              // должны узнать о ней тем же сообщением (карта и редактор
              // свойств читают реестр).
              if (item.property_id !== null) {
                const pairProperty = getNetworkProperty(ndb, item.property_id);
                if (pairProperty !== null) {
                  events.push({
                    type: 'property-registry.created',
                    data: { property: pairProperty },
                  });
                  activity.push({ kind: 'property', action: 'created', property: pairProperty });
                }
              }
            } else {
              events.push({
                type: 'link-type.updated',
                data: { id: item.id, version: item.version, changes: {} },
              });
              // Имя пары следует за типом: если оно реально изменилось —
              // отдельное событие реестра и запись в журнале активности.
              if (item.property_id !== null) {
                const pair = getNetworkProperty(ndb, item.property_id);
                const nameBefore = pairNamesBefore.get(item.property_id);
                if (pair !== null && nameBefore !== undefined && nameBefore !== pair.name) {
                  events.push({
                    type: 'property-registry.updated',
                    data: { id: pair.id, changes: { name: pair.name } },
                  });
                  activity.push({ kind: 'property', action: 'updated', property: pair });
                  linkPropertiesRenamed += 1;
                }
              }
            }
          }
          for (const item of written.properties) {
            if (item.action === 'unchanged') continue;
            const prop = getNetworkProperty(ndb, item.id);
            if (prop === null) continue;
            if (item.action === 'created') {
              events.push({ type: 'property-registry.created', data: { property: prop } });
              activity.push({ kind: 'property', action: 'created', property: prop });
            } else {
              events.push({
                type: 'property-registry.updated',
                data: {
                  id: item.id,
                  converted: item.converted_values,
                  dropped: item.dropped_values,
                  changes: {},
                },
              });
            }
          }
          for (const item of written.type_properties) {
            if (item.action === 'unchanged') continue;
            // Подключение свойства — это правка типа-владельца; в журнале
            // фиксируем как обновление самого типа (требование b0c7a57c).
            // Перечитываем привязку после её создания/обновления, чтобы
            // передать полный snapshot в payload `property-definition.*`.
            const defRow = getTypeProperty(ndb, item.id);
            if (defRow === null) continue;
            const propertyRow = getNetworkProperty(ndb, defRow.property_id);
            if (propertyRow === null) continue;
            const definitionPayload = {
              id: defRow.id,
              property_id: defRow.property_id,
              owner_type: defRow.owner_type,
              owner_id: defRow.owner_id,
              key: propertyRow.name,
              value_type: propertyRow.value_type,
              config: propertyRow.config,
              required: defRow.required,
              position: defRow.position,
              description: propertyRow.description,
            };
            events.push({
              type: 'property-definition.created',
              data: { definition: definitionPayload },
            });
            activity.push({
              kind: 'type-property',
              action: 'updated',
              typeId: definitionPayload.owner_id,
              typeName: definitionPayload.key,
            });
          }

          // ---- type_views events (задача c1fa71d4, 0.7.3) -------------
          // По одному событию `thought-type-view.{created,updated,deleted}` на
          // изменённую сущность; `unchanged` пропускаем (идемпотентный upsert).
          for (const item of written.type_views) {
            if (item.action === 'unchanged') continue;
            if (item.action === 'created') {
              // Перечитываем созданный отбор для payload `view` (effective DTO).
              const viewRow = getThoughtTypeView(ndb, item.id);
              if (viewRow === null) continue;
              events.push({
                type: 'thought-type-view.created',
                data: {
                  thought_type_id: viewRow.thought_type_id,
                  view: {
                    ...viewRow,
                    defined_on: viewRow.thought_type_id,
                    inherited: false,
                    own_default: viewRow.is_default,
                  },
                },
              });
            } else if (item.action === 'updated') {
              const viewRow = getThoughtTypeView(ndb, item.id);
              if (viewRow === null) continue;
              events.push({
                type: 'thought-type-view.updated',
                data: {
                  thought_type_id: viewRow.thought_type_id,
                  view_id: viewRow.id,
                  changes: {},
                  version: viewRow.version,
                  view: {
                    ...viewRow,
                    defined_on: viewRow.thought_type_id,
                    inherited: false,
                    own_default: viewRow.is_default,
                  },
                },
              });
            } else {
              // deleted
              const snapshot = deletedViewSnapshots.get(item.id);
              events.push({
                type: 'thought-type-view.deleted',
                data: {
                  thought_type_id: item.thought_type_id,
                  view_id: item.id,
                  ...(snapshot !== undefined ? { view: snapshot } : {}),
                },
              });
            }
          }

          return {
            result: written,
            events,
            activity,
            // ONE audit row for the whole batch.
            audit: {
              action: 'etn.ontology.write',
              targetType: 'network',
              targetId: args.network_id,
              details: {
                thought_types_count: written.thought_types.length,
                link_types_count: written.link_types.length,
                // Парные свойства-связи, созданные автосозданием из link_types[]
                // (ошибка 117a999a), — отдельный счётчик: в properties[] их нет.
                link_properties_created: written.link_types.filter(
                  (item) => item.action === 'created' && item.property_id !== null,
                ).length,
                // Переименования пар вслед за типом (ошибка 117a999a): только
                // фактическая смена имени, идемпотентная перезапись не в счёт.
                link_properties_renamed: linkPropertiesRenamed,
                properties_count: written.properties.length,
                type_properties_count: written.type_properties.length,
                type_views_count: written.type_views.length,
              },
            },
          };
        });

        const layer = resolveRuntimeLayer(rt, args.network_id);
        return {
          ...result,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        } satisfies OntologyWriteResult & {
          layer: { id: string; title: string };
          request_id: string;
        };
      }),
  );

  // `etn.ontology.delete` (0.8.3, задача d379e091) снят из постоянного набора
  // — упакован в `etn.ops { action: "ontology.delete" }` с обязательным
  // верхнеуровневым `confirm: true` (tools/ops.ts). Схема `params` перенесена
  // в `contracts.ts` (`OntologyDelete`), чтобы реестр `ops-catalog` валидировал
  // её той же схемой.

  // =========================================================================
  // P3 (задача e488f4c1 / 0.7.2) — copy_subtree, mentions_scan, импорт/экспорт
  // =========================================================================
}
