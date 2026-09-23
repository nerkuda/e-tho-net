/**
 * properties.ts — MCP-инструменты области «registerPropertiesTools, registerUsageClearTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import {
  PropertiesAdd,
} from '../../contracts.js';
import { getLink } from '../../domain/link-service.js';
import { addLinkPropertyValue } from '../../domain/property-service.js';
import {
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
  // `etn.properties.remove` (0.8.3, задача 86ef2ff4) снят из постоянного
  // набора — упакован в `etn.ops { action: "properties.remove" }` (tools/ops.ts).

  // `etn.properties.resolve` (0.8.3, задача d379e091) — тоже действие
  // `etn.ops` (`properties.resolve`): read-only сервисная операция, снята
  // одним мажором без алиасов. Обработчик — в `tools/ops.ts`.
}

// `etn.thoughts.usage_clear` (0.8.3, задача 86ef2ff4) снят из постоянного
// набора — упакован в `etn.ops { action: "usage_clear" }` (tools/ops.ts).
