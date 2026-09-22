/**
 * properties.ts — MCP-инструменты области «registerPropertiesTools, registerUsageClearTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import {
  PropertiesAdd,
  PropertiesRemove,
  PropertiesResolve,
  ThoughtsUsageClear,
} from '../../contracts.js';
import { getLink } from '../../domain/link-service.js';
import {
  addLinkPropertyValue,
  clearThoughtRefUsages,
  crossResolvePropertyValue,
  removeLinkPropertyValue,
} from '../../domain/property-service.js';
import type { CrossNetworkAccessContext } from '../../domain/cross-network-ref-service.js';
import { SystemDb } from '../../db/system-db.js';
import {
  mcpLayerClientId,
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runWrite,
  runWriteTool,
} from '../context.js';

export const PropertyValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().min(1)),
  z.null(),
]);
export function registerPropertiesTools(mcp: McpServer, rt: McpRuntime): void {
  // 0.8.1 (b3ce5014): операции над набором свойства-связи — добавить/убрать одну
  // цель, без чтения текущего набора. `add` принимает необязательный комментарий.
  mcp.registerTool(
    'etn.properties.add',
    {
      title: 'Добавить цель в свойство-связь',
      description:
        'Add one target (thought id) to a link property by key — idempotent: an already-live edge is a ' +
        'no-op. Accepts an optional `comment` explaining «why this link». Direction comes from the property ' +
        'definition, never from the call. Returns { link_id, created }.',
      inputSchema: PropertiesAdd.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.add'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const res = runWrite(ndb, fx, () => {
          const result = addLinkPropertyValue(
            ndb,
            args.owner_type,
            args.owner_id,
            args.key,
            args.value,
            args.comment ?? null,
            rt.deps.auth.userId,
          );
          const createdLink = result.created ? getLink(ndb, result.link_id) : null;
          return {
            result,
            ...(createdLink === null
              ? {}
              : {
                  events: [{ type: 'link.created' as const, data: { link: createdLink } }],
                  activity: [
                    { kind: 'link' as const, action: 'created' as const, link: createdLink },
                  ],
                }),
            audit: {
              action: 'etn.properties.add',
              targetType: args.owner_type,
              targetId: args.owner_id,
              details: { key: args.key, value: args.value, comment: args.comment },
            },
          };
        });
        return {
          link_id: res.link_id,
          created: res.created,
          request_id: String(extra.requestId),
        };
      }),
  );
  mcp.registerTool(
    'etn.properties.remove',
    {
      title: 'Убрать цель из свойства-связи',
      description:
        'Remove one target (thought id) from a link property by key — marks the edge for deletion (trash), ' +
        'preserving its comment. Idempotent: an absent edge is a no-op (`link_id: null`). Returns ' +
        '{ link_id }.',
      inputSchema: PropertiesRemove.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.remove'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const res = runWrite(ndb, fx, () => {
          const result = removeLinkPropertyValue(
            ndb,
            args.owner_type,
            args.owner_id,
            args.key,
            args.value,
            rt.deps.auth.userId,
          );
          // Помечаем в корзину — событие `link.updated` с marked_for_deletion
          // (журнал пишет `trashed`, а не `deleted`).
          const marked = result.link_id !== null ? getLink(ndb, result.link_id) : null;
          return {
            result,
            ...(marked === null
              ? {}
              : {
                  events: [
                    {
                      type: 'link.updated' as const,
                      data: {
                        id: marked.id,
                        changes: { marked_for_deletion: true },
                        version: marked.version,
                      },
                    },
                  ],
                  activity: [{ kind: 'link' as const, action: 'trashed' as const, link: marked }],
                }),
            audit: {
              action: 'etn.properties.remove',
              targetType: args.owner_type,
              targetId: args.owner_id,
              details: { key: args.key, value: args.value },
            },
          };
        });
        return { link_id: res.link_id, request_id: String(extra.requestId) };
      }),
  );

  // 0.8.3 (задача 7849008a, спека 46df7a8d): etn.properties.resolve — явный
  // резолв значений `cross_network_ref`. Служебная операция, без
  // write-бюджета и audit-записи (требование c104a0fc).
  mcp.registerTool(
    'etn.properties.resolve',
    {
      title: 'Резолв кросс-сетевой ссылки',
      description:
        'Resolve a cross-network property value (задача 7849008a, ADR ae8346d0): ' +
        'for every visible value of the property opens the target network, ' +
        'reads the target title, updates the snapshot; target/network gone → ' +
        'marks value as `unresolved` while keeping the old title. Service record — ' +
        'no write budget, no audit row. Returns `values: CrossNetworkRefValue[]`.',
      inputSchema: PropertiesResolve.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.resolve'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Список сетей пользователя — для прав при открытии чужой data.db.
        const sysDb = SystemDb.open(rt.deps.dataDir, rt.deps.logger);
        let accessibleNetworkIds: ReadonlySet<string>;
        try {
          accessibleNetworkIds = new Set(
            sysDb.listNetworksForUser(rt.deps.auth.userId).map((n) => n.id),
          );
        } finally {
          sysDb.close();
        }
        const ctx: CrossNetworkAccessContext = {
          dataDir: rt.deps.dataDir,
          userId: rt.deps.auth.userId,
          clientId: mcpLayerClientId(rt),
          logger: rt.deps.logger,
          accessibleNetworkIds,
          currentNetworkId: args.network_id,
        };
        const values = crossResolvePropertyValue(
          ndb,
          args.owner_type,
          args.owner_id,
          args.key,
          ctx,
        );
        return { values, request_id: String(extra.requestId) };
      }),
  );
}

export function registerUsageClearTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.thoughts.usage_clear',
    {
      title: 'Очистить использование мысли',
      description:
        'Trash every blocking link-property edge of other thoughts that references this one — clears ' +
        'the «использование в свойствах» blocking arm in one call instead of editing each property. ' +
        'Returns { cleared }.',
      inputSchema: ThoughtsUsageClear.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const cleared = runWrite(ndb, fx, () => {
          getThoughtOrThrow(ndb, args.thought_id);
          const result = clearThoughtRefUsages(ndb, args.thought_id);
          return {
            result,
            audit: {
              action: 'etn.thoughts.usage_clear',
              targetType: 'thought',
              targetId: args.thought_id,
              details: { cleared: result },
            },
          };
        });
        return { cleared, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // Object-locks (task a88acf20, операция b6b776ff «etn.locks.*»)
  // -------------------------------------------------------------------------
  // Паритет с REST `/locks` (задача 2031df5e). Семантика ошибок единая:
  //   * `LOCKED` (409)        — acquire чужого захвата, `details.holder`
  //     содержит `{ user_id, client_id, acquired_at_ms }`.
  //   * `LOCK_NOT_FOUND` (404) — release несуществующего lock_id.
  //   * `FORBIDDEN` (403)     — release чужого захвата.
  //   * `VALIDATION_ERROR` (422) — обязательные поля.
  //
  // События real-time `edit.acquired` / `edit.released` / `edit.cleared`
  // эмитятся через `emitAgentEvent` — они доходят до подписчиков через тот же
  // поток, что и REST-события (`emitDomainEvent` использует
  // `REALTIME_EVENT_AUDIENCE[type]`, для `edit.*` это `network`).
  // В журнал активности захваты НЕ пишутся — требование b0c7a57c — поэтому
  // здесь именно `emitAgentEvent`, а не `emitAgentActivityEvent`.
  // =========================================================================
}
