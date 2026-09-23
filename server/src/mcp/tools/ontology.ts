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
import { getNetworkProperty, getTypeProperty } from '../../domain/property-service.js';
import { OntologyWrite } from '../../contracts.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { getLinkType } from '../../domain/link-type-service.js';
import { writeOntology } from '../../domain/ontology-write-service.js';
import {
  getThoughtTypeView,
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
      title: 'Батч-запись онтологии',
      description:
        'Идемпотентный upsert онтологии сети одной транзакцией: `thought_types[]` / `link_types[]` / ' +
        '`properties[]` / `type_properties[]` / `type_views[]`. ' +
        'Upsert по `id` XOR имени — повторный вызов с теми же аргументами не меняет состояние ' +
        '(`action: unchanged` для каждого элемента). Локальные `ref` ' +
        '(`parent_ref` для типов, `type_ref`/`property_ref` для привязок, ' +
        '`thought_type_ref`/`ref_for_update` для отборов) действуют только внутри батча. ' +
        'Цикл `parent_ref` → VALIDATION_ERROR. Смена `value_type` свойства использует ту же доменную ' +
        'функцию конверсии, что `PATCH /properties/{id}`; ответ несёт `converted_values`/`dropped_values`. ' +
        'Свойство-связь ↔ link_type — единый жизненный цикл: ' +
        '`properties[]` с `value_type="link"` и парой `name_forward`/`name_reverse` создаёт ' +
        'связанный link_type автоматически. `type_properties[].side` — `source`/`target`, ' +
        'сторона привязки свойства-связи. `type_properties[].default_value` — дефолт привязки: ' +
        'скаляр, `null` (сброс) или массив id мыслей; пишется строкой ' +
        '`type_property_overrides` с учётом стороны привязки. ' +
        '`type_views[]` — отборы типов мыслей: ' +
        '`action: create|update|delete`, `thought_type` XOR `thought_type_ref`. ' +
        'Смена `parent`/`parent_ref` у типа мысли или связи: ' +
        'интерактива нет, MCP применяет правила немедленно. Если в ЛЮБОМ живом ' +
        '(не базовом) слое есть мысли (для thought-types) или связи (для link-types) ' +
        'с типом из множества {изменяемый + потомки + старый/новый родитель} — ' +
        'отказ `422` с `details.kind = "reparent_blocked_by_layer"` и перечнем ' +
        'слоёв. Для типов мыслей без живых слоёв — записи применяются без ' +
        'интерактивного подтверждения (UI-флаг `confirmed` для REST не имеет ' +
        'MCP-аналога; ответ `details.kind = "reparent_impact"` здесь НЕ возникает). ' +
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

  // `etn.ontology.delete` (0.8.3, задача d379e091) снят из постоянного набора
  // — упакован в `etn.ops { action: "ontology.delete" }` с обязательным
  // верхнеуровневым `confirm: true` (tools/ops.ts). Схема `params` перенесена
  // в `contracts.ts` (`OntologyDelete`), чтобы реестр `ops-catalog` валидировал
  // её той же схемой.

  // =========================================================================
  // P3 (задача e488f4c1 / 0.7.2) — copy_subtree, mentions_scan, импорт/экспорт
  // =========================================================================
}
