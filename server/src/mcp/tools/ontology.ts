/**
 * ontology.ts — MCP-инструменты области «registerOntologyTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { ICON_KINDS, MCP_TOOL_ANNOTATIONS, PROPERTY_VALUE_TYPES, TYPE_OWNER_TYPES } from '@etn/shared';
import type { OntologyDeleteParams, OntologyDeleteResult, OntologyWriteParams, OntologyWriteResult } from '@etn/shared';
import { getNetworkProperty, getTypeProperty } from '../../domain/property-service.js';
import { defineContract, OntologyWrite } from '../../contracts.js';
import { getThoughtType } from '../../domain/thought-type-service.js';
import { getLinkType } from '../../domain/link-type-service.js';
import { writeOntology } from '../../domain/ontology-write-service.js';
import { deleteOntologyEntity } from '../../domain/ontology-delete-service.js';
import { getThoughtTypeView, listThoughtTypeViewsByType } from '../../domain/thought-type-views-service.js';
import { auditAgentCall, emitAgentActivityEvent, emitAgentEvent, openMemberNetwork, requireWritable, requireWriteBudget, resolveRuntimeLayer, runWriteTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerOntologyTools(mcp: McpServer, rt: McpRuntime): void {
  const OntologyWriteThoughtTypeSchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name: z.string().min(1).optional(),
      parent: z.string().min(1).nullable().optional(),
      parent_ref: z.string().min(1).nullable().optional(),
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      icon_kind: z.enum(ICON_KINDS).optional(),
      fg_color: z.string().nullable().optional(),
      bg_color: z.string().nullable().optional(),
      font_bold: z.boolean().nullable().optional(),
      font_italic: z.boolean().nullable().optional(),
      font_underline: z.boolean().nullable().optional(),
      font_strike: z.boolean().nullable().optional(),
      comment_template_md: z.string().nullable().optional(),
    })
    .strict();
  const OntologyWriteLinkTypeSchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name_forward: z.string().min(1).optional(),
      name_reverse: z.string().min(1).optional(),
      parent: z.string().min(1).nullable().optional(),
      parent_ref: z.string().min(1).nullable().optional(),
      color: z.string().nullable().optional(),
      style: z.enum(['solid', 'dashed', 'dotted']).nullable().optional(),
      width: z.number().int().min(1).max(20).nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .strict();
  const OntologyWritePropertySchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name: z.string().min(1).optional(),
      value_type: z.enum(PROPERTY_VALUE_TYPES).optional(),
      config: z.record(z.string(), z.unknown()).nullable().optional(),
      description: z.string().nullable().optional(),
      // Единый жизненный цикл свойства-связи ↔ link_type (0.8.1, требование
      // 09f692ff): при `value_type="link"` и непустом `name_forward`+
      // `name_reverse` сервер сам создаёт тип связи. Остальные поля —
      // оформление нового типа. Для скалярных свойств игнорируются.
      name_forward: z.string().min(1).optional(),
      name_reverse: z.string().min(1).optional(),
      parent_link_type_id: z.string().min(1).nullable().optional(),
      link_color: z.string().nullable().optional(),
      link_style: z.enum(['solid', 'dashed', 'dotted']).nullable().optional(),
      link_width: z.number().int().min(1).max(20).nullable().optional(),
    })
    .strict();
  const OntologyWriteTypePropertySchema = z
    .object({
      owner: z.enum(TYPE_OWNER_TYPES),
      type: z.string().min(1).optional(),
      type_ref: z.string().min(1).optional(),
      property: z.string().min(1).optional(),
      property_ref: z.string().min(1).optional(),
      required: z.boolean().optional(),
      position: z.number().int().min(0).optional(),
      // Сторона привязки свойства-связи (0.8.1, задача d7177d1d): `source`/
      // `target`. Для скалярных и структурных свойств игнорируется.
      side: z.enum(['source', 'target']).nullable().optional(),
    })
    .strict();
  // `type_views[]` (задача c1fa71d4, 0.7.3, ADR 5c44f6a7). Правка отборов
  // идёт тем же батчем онтологии: `action: create|update|delete`,
  // `thought_type` XOR `thought_type_ref`, `id` XOR `ref_for_update` для
  // update/delete.
  const OntologyWriteTypeViewSchema = z
    .object({
      ref: z.string().min(1).optional(),
      action: z.enum(['create', 'update', 'delete']),
      id: z.string().min(1).optional(),
      ref_for_update: z.string().min(1).optional(),
      thought_type: z.string().min(1).optional(),
      thought_type_ref: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      definition: z.string().min(1).optional(),
      position: z.number().int().min(0).optional(),
      is_default: z.boolean().optional(),
    })
    .strict();
  const OntologyWriteSchema = z.object({
    network_id: NetworkId,
    thought_types: z.array(OntologyWriteThoughtTypeSchema).optional(),
    link_types: z.array(OntologyWriteLinkTypeSchema).optional(),
    properties: z.array(OntologyWritePropertySchema).optional(),
    type_properties: z.array(OntologyWriteTypePropertySchema).optional(),
    type_views: z.array(OntologyWriteTypeViewSchema).optional(),
  });
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
        'сторона привязки свойства-связи. `type_views[]` — отборы типов мыслей: ' +
        '`action: create|update|delete`, `thought_type` XOR `thought_type_ref`. ' +
        'Доменная валидация имени (уникальность в пределах типа), токенов и `is_default` — как у ' +
        '`POST /thought-types/{id}/views`. ' +
        'Один write-бюджет + одна строка `audit_log` на ВЕСЬ вызов; real-time события — по одному на ' +
        'изменённую сущность (`thought-type.*`, `link-type.*`, `property-registry.*`, ' +
        '`property-definition.*`).',
      inputSchema: OntologyWrite.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ontology.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const writeInput: OntologyWriteParams = {
          network_id: args.network_id,
          ...(args.thought_types !== undefined ? { thought_types: args.thought_types } : {}),
          ...(args.link_types !== undefined ? { link_types: args.link_types } : {}),
          ...(args.properties !== undefined ? { properties: args.properties } : {}),
          ...(args.type_properties !== undefined ? { type_properties: args.type_properties } : {}),
          ...(args.type_views !== undefined ? { type_views: args.type_views } : {}),
        };
        const result = writeOntology(ndb, writeInput, rt.deps.auth.userId);

        // Real-time + activity log: по одной записи на изменённую сущность.
        // Снимок для удалённого берётся ДО мутации (тут мутация уже
        // произошла — но мы используем `unchanged` как маркер для пропуска).
        for (const item of result.thought_types) {
          if (item.action === 'unchanged') continue;
          // After create/update — read back the type for the snapshot.
          const thoughtType = getThoughtType(ndb, item.id);
          if (thoughtType === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type.created',
              { type: thoughtType },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type.updated',
              { id: item.id, version: item.version, changes: {} },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.link_types) {
          if (item.action === 'unchanged') continue;
          const linkType = getLinkType(ndb, item.id);
          if (linkType === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'link-type.created',
              { type: linkType },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'link-type.updated',
              { id: item.id, version: item.version, changes: {} },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.properties) {
          if (item.action === 'unchanged') continue;
          const prop = getNetworkProperty(ndb, item.id);
          if (prop === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-registry.created',
              { property: prop },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-registry.updated',
              {
                id: item.id,
                converted: item.converted_values,
                dropped: item.dropped_values,
                changes: {},
              },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.type_properties) {
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
          emitAgentActivityEvent(
            rt,
              args.network_id,
              'property-definition.created',
              {
                definition: definitionPayload,
              },
              ndb,
              extra.requestId,
            );
          }

        // ---- type_views events (задача c1fa71d4, 0.7.3) -------------
        // По одному событию `thought-type-view.{created,updated,deleted}` на
        // изменённую сущность; `unchanged` пропускаем (идемпотентный upsert).
        for (const item of result.type_views) {
          if (item.action === 'unchanged') continue;
          if (item.action === 'created') {
            // Перечитываем созданный отбор для payload `view` (effective DTO).
            const viewRow = getThoughtTypeView(ndb, item.id);
            if (viewRow === null) continue;
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type-view.created',
              {
                thought_type_id: viewRow.thought_type_id,
                view: {
                  ...viewRow,
                  defined_on: viewRow.thought_type_id,
                  inherited: false,
                },
              },
              ndb,
              extra.requestId,
            );
          } else if (item.action === 'updated') {
            const viewRow = getThoughtTypeView(ndb, item.id);
            if (viewRow === null) continue;
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type-view.updated',
              {
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
              ndb,
              extra.requestId,
            );
          } else {
            // deleted
            emitAgentEvent(
              rt,
              args.network_id,
              'thought-type-view.deleted',
              { thought_type_id: item.thought_type_id, view_id: item.id },
              extra.requestId,
            );
          }
        }

        // ONE audit row for the whole batch.
        auditAgentCall(
          rt,
          'etn.ontology.write',
          args.network_id,
          'network',
          args.network_id,
          {
            thought_types_count: result.thought_types.length,
            link_types_count: result.link_types.length,
            properties_count: result.properties.length,
            type_properties_count: result.type_properties.length,
            type_views_count: result.type_views.length,
          },
        );

        const layer = resolveRuntimeLayer(rt, args.network_id);
        return {
          ...result,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        } satisfies OntologyWriteResult & { layer: { id: string; title: string }; request_id: string };
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
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        const networkRoles = network?.type_roles ?? {};
        // Pre-fetch snapshots BEFORE the mutation, to record accurate activity rows.
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
        const deleteInput: OntologyDeleteParams = {
          network_id: args.network_id,
          kind: args.kind,
          id: args.id,
          ...(args.force !== undefined ? { force: args.force } : {}),
        };
        const result: OntologyDeleteResult = deleteOntologyEntity(
          ndb,
          deleteInput,
          rt.deps.auth.userId,
          networkRoles,
        );

        // Real-time + activity log (mirror REST).
        if (snapshot !== null && snapshot !== undefined) {
          if (args.kind === 'thought_type') {
            emitAgentEvent(
              rt,
              args.network_id,
              'thought-type.deleted',
              { id: args.id },
              extra.requestId,
            );
            // Каскад отборов (задача c1fa71d4): отдельное событие
            // `thought-type-view.deleted` на каждый каскадно удалённый отбор,
            // чтобы агенты с подпиской могли его поймать.
            const cascadedViews =
              (result.affected_counts.type_views_count ?? 0) > 0
                ? listThoughtTypeViewsByType(ndb, args.id).map((v) => ({ id: v.id }))
                : [];
            for (const view of cascadedViews) {
              emitAgentEvent(
                rt,
                args.network_id,
                'thought-type-view.deleted',
                { thought_type_id: args.id, view_id: view.id },
                extra.requestId,
              );
            }
          } else if (args.kind === 'link_type') {
            emitAgentEvent(
              rt,
              args.network_id,
              'link-type.deleted',
              { id: args.id },
              extra.requestId,
            );
          } else if (args.kind === 'property') {
            emitAgentEvent(
              rt,
              args.network_id,
              'property-registry.deleted',
              { id: args.id },
              extra.requestId,
            );
          } else if (args.kind === 'type_view') {
            // Отдельная ветка задачи c1fa71d4: `type_view` удаляется
            // без `snapshot` (он не нужен — у отбора нет rich-DTO для
            // эха), событие шлём всегда.
            emitAgentEvent(
              rt,
              args.network_id,
              'thought-type-view.deleted',
              { thought_type_id: '', view_id: args.id },
              extra.requestId,
            );
          }
        } else if (args.kind === 'type_view') {
          // snapshot null (отбор уже удалили раньше или не было): всё равно
          // шлём событие, чтобы подписчики узнали об удалении.
          emitAgentEvent(
            rt,
            args.network_id,
            'thought-type-view.deleted',
            { thought_type_id: '', view_id: args.id },
            extra.requestId,
          );
        }

        // ONE audit row for the whole call.
        auditAgentCall(
          rt,
          'etn.ontology.delete',
          args.network_id,
          args.kind,
          args.id,
          {
            force: args.force === true,
            affected_counts: result.affected_counts,
          },
        );

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
