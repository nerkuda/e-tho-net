/**
 * ontology.ts — MCP-инструменты области «registerOntologyTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type {
  OntologyDeleteParams,
  OntologyDeleteResult,
  OntologyWriteParams,
  OntologyWriteResult,
} from '@etn/shared';
import { getNetworkProperty, getTypeProperty } from '../../domain/property-service.js';
import { defineContract, OntologyWrite } from '../../contracts.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { getLinkType } from '../../domain/link-type-service.js';
import { writeOntology } from '../../domain/ontology-write-service.js';
import { deleteOntologyEntity } from '../../domain/ontology-delete-service.js';
import {
  getThoughtTypeView,
  listThoughtTypeViewsByType,
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
import { NetworkId } from './shared.js';

export function registerOntologyTools(mcp: McpServer, rt: McpRuntime): void {
  // `type_views[]` (задача c1fa71d4, 0.7.3, ADR 5c44f6a7). Правка отборов
  // идёт тем же батчем онтологии: `action: create|update|delete`,
  // `thought_type` XOR `thought_type_ref`, `id` XOR `ref_for_update` для
  // update/delete.
  mcp.registerTool(
    'etn.ontology.write',
    {
      title: 'Батч-запись онтологии',
      description:
        'Идемпотентный upsert онтологии сети одной транзакцией: `thought_types[]` / `link_types[]` / ' +
        '`properties[]` / `type_properties[]` / `type_views[]` (задача c1fa71d4, 0.7.3). ' +
        'Upsert по `id` XOR имени — повторный вызов с теми же аргументами не меняет состояние ' +
        '(`action: unchanged` для каждого элемента). Локальные `ref` ' +
        '(`parent_ref` для типов, `type_ref`/`property_ref` для привязок, ' +
        '`thought_type_ref`/`ref_for_update` для отборов) действуют только внутри батча. ' +
        'Цикл `parent_ref` → VALIDATION_ERROR. Смена `value_type` свойства использует ту же доменную ' +
        'функцию конверсии, что `PATCH /properties/{id}`; ответ несёт `converted_values`/`dropped_values`. ' +
        'Свойство-связь ↔ link_type — единый жизненный цикл (0.8.1, требование 09f692ff): ' +
        '`properties[]` с `value_type="link"` и парой `name_forward`/`name_reverse` создаёт ' +
        'связанный link_type автоматически. `type_properties[].side` — `source`/`target`, ' +
        'сторона привязки свойства-связи. `type_properties[].default_value` — дефолт привязки ' +
        '(0.8.2): скаляр, `null` (сброс) или массив id мыслей; пишется строкой ' +
        '`type_property_overrides` с учётом стороны привязки. ' +
        '`type_views[]` — отборы типов мыслей: ' +
        '`action: create|update|delete`, `thought_type` XOR `thought_type_ref`. ' +
        'Доменная валидация имени (уникальность в пределах типа), токенов и `is_default` — как у ' +
        '`POST /thought-types/{id}/views`. ' +
        'Один write-бюджет + одна строка `audit_log` на ВЕСЬ вызов; real-time события — по одному на ' +
        'изменённую сущность (`thought-type.*`, `link-type.*`, `property-registry.*`, ' +
        '`property-definition.*`). Неизвестные ключи верхнего уровня (например, секция вне ' +
        '`thought_types[]`/`link_types[]`/... ) отвергаются `VALIDATION_ERROR` (`details.fields`), ' +
        'а не игнорируются.',
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
          const written = writeOntology(ndb, writeInput, rt.deps.auth.userId);

          // Real-time + activity log: по одной записи на изменённую сущность.
          // События и журнал собираются из результата записи и исполняются
          // обёрткой после коммита.
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
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
            } else {
              events.push({
                type: 'link-type.updated',
                data: { id: item.id, version: item.version, changes: {} },
              });
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
                  },
                },
              });
            } else {
              // deleted
              events.push({
                type: 'thought-type-view.deleted',
                data: { thought_type_id: item.thought_type_id, view_id: item.id },
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

  const OntologyDeleteSchema = z.object({
    network_id: NetworkId,
    // `type_view` (задача c1fa71d4, 0.7.3) — отбор типа мысли.
    kind: z.enum(['thought_type', 'link_type', 'property', 'type_property', 'type_view']),
    id: z.string().min(1),
    force: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.ontology.delete',
    {
      title: 'Удалить элемент онтологии',
      description:
        'Удалить одну сущность онтологии (`thought_type` / `link_type` / `property` / `type_property` ' +
        '/ `type_view`, задача c1fa71d4 / 0.7.3). ' +
        'Без `force` отвергается на используемых элементах со счётчиками в `details` ' +
        '(`thoughts_count` / `links_count` / `property_values_count` / `type_properties_count`). ' +
        'С `force` — каскад по правилам: `thought_type` обнуляет `type_id` связанных мыслей + ' +
        '`type_properties` + отборы типа (`type_views_count` в affected_counts); ' +
        '`link_type` удаляет связи этого типа (со свойствами и комментариями) + ' +
        '`type_properties`; `property` удаляет `property_values` + `type_properties`; ' +
        '`type_property` удаляет строку привязки; `type_view` удаляется безусловно ' +
        '(не имеет использований). Элемент, занятый в `type_roles` сети, отвергается даже с `force`. ' +
        'HOME-мысль не имеет типа и не задевается. Один write-бюджет + одна строка `audit_log`.',
      inputSchema: defineContract('etn.ontology.delete', OntologyDeleteSchema, {}).schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ontology.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        const networkRoles = network?.type_roles ?? {};
        const deleteInput: OntologyDeleteParams = {
          network_id: args.network_id,
          kind: args.kind,
          id: args.id,
          ...(args.force !== undefined ? { force: args.force } : {}),
        };
        const result: OntologyDeleteResult = runWrite(ndb, fx, () => {
          // Pre-fetch snapshots BEFORE the mutation, to record accurate
          // activity rows (mirror REST).
          let snapshot: unknown = null;
          try {
            if (args.kind === 'thought_type') {
              snapshot = getThoughtType(ndb, args.id);
            } else if (args.kind === 'link_type') {
              snapshot = getLinkType(ndb, args.id);
            } else if (args.kind === 'property') {
              snapshot = getNetworkProperty(ndb, args.id);
            }
          } catch {
            snapshot = null;
          }
          const removed = deleteOntologyEntity(ndb, deleteInput, rt.deps.auth.userId, networkRoles);

          // Real-time (mirror REST); журнал активности прежний MCP-путь не
          // писал (только события) — сохраняем поведение.
          const events: AnyWriteEvent[] = [];
          if (snapshot !== null && snapshot !== undefined) {
            if (args.kind === 'thought_type') {
              events.push({ type: 'thought-type.deleted', data: { id: args.id } });
              // Каскад отборов (задача c1fa71d4): отдельное событие
              // `thought-type-view.deleted` на каждый каскадно удалённый отбор,
              // чтобы агенты с подпиской могли его поймать.
              const cascadedViews =
                (removed.affected_counts.type_views_count ?? 0) > 0
                  ? listThoughtTypeViewsByType(ndb, args.id).map((v) => ({ id: v.id }))
                  : [];
              for (const view of cascadedViews) {
                events.push({
                  type: 'thought-type-view.deleted',
                  data: { thought_type_id: args.id, view_id: view.id },
                });
              }
            } else if (args.kind === 'link_type') {
              events.push({ type: 'link-type.deleted', data: { id: args.id } });
            } else if (args.kind === 'property') {
              events.push({ type: 'property-registry.deleted', data: { id: args.id } });
            } else if (args.kind === 'type_view') {
              // Отдельная ветка задачи c1fa71d4: `type_view` удаляется
              // без `snapshot` (он не нужен — у отбора нет rich-DTO для
              // эха), событие шлём всегда.
              events.push({
                type: 'thought-type-view.deleted',
                data: { thought_type_id: '', view_id: args.id },
              });
            }
          } else if (args.kind === 'type_view') {
            // snapshot null (отбор уже удалили раньше или не было): всё равно
            // шлём событие, чтобы подписчики узнали об удалении.
            events.push({
              type: 'thought-type-view.deleted',
              data: { thought_type_id: '', view_id: args.id },
            });
          }

          return {
            result: removed,
            events,
            // ONE audit row for the whole call.
            audit: {
              action: 'etn.ontology.delete',
              targetType: args.kind,
              targetId: args.id,
              details: {
                force: args.force === true,
                affected_counts: removed.affected_counts,
              },
            },
          };
        });

        return {
          ...result,
          request_id: String(extra.requestId),
        } satisfies OntologyDeleteResult & { request_id: string };
      }),
  );

  // =========================================================================
  // P3 (задача e488f4c1 / 0.7.2) — copy_subtree, mentions_scan, импорт/экспорт
  // =========================================================================
}
