/**
 * chronicle.ts — MCP-инструменты области «registerChronicleQueryTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { parseChronicleQueryBody, queryChronicle } from '../../domain/chronicle-service.js';
import { ChronicleQuery } from '../../contracts.js';
import { resolveThoughtTypeIdByName } from '../../domain/thought-type-service.js';
import { resolveLinkTypeIdByName } from '../../domain/link-type-service.js';
import { openMemberNetwork, runTool } from '../context.js';

export function registerChronicleQueryTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.chronicle.query',
    {
      title: 'Запрос хроники',
      description:
        'Запрос хроники (паритет `POST /chronicle/query`): хроно-комментарии по ' +
        'фильтру мыслей; `targets` — критерии целей.',
      inputSchema: ChronicleQuery.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.chronicle.query'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Резолв имён типов в id (задача d5ab1630 + 77351f03).
        const typeIds = args.type === undefined
          ? args.type_id
          : (Array.isArray(args.type_id) ? args.type_id : []).concat([
              resolveThoughtTypeIdByName(ndb, args.type),
            ]);
        const linkTypeIds = args.link_type === undefined
          ? args.link_type_id
          : (Array.isArray(args.link_type_id) ? args.link_type_id : []).concat([
              resolveLinkTypeIdByName(ndb, args.link_type),
            ]);
        // Сборка тела запроса под domain `parseChronicleQueryBody` —
        // повторяет ключи REST с минимальной правкой имён.
        const body: Record<string, unknown> = {};
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.keyword_scope !== undefined) body.keyword_scope = args.keyword_scope;
        if (args.thought_ids !== undefined) body.thought_ids = args.thought_ids;
        if (args.include_subtree !== undefined) body.include_subtree = args.include_subtree;
        if (typeIds !== undefined) body.type_ids = typeIds;
        if (linkTypeIds !== undefined) body.link_type_ids = linkTypeIds;
        if (args.link_scope !== undefined) body.link_scope = args.link_scope;
        if (args.date_from !== undefined) body.date_from = args.date_from;
        if (args.date_to !== undefined) body.date_to = args.date_to;
        if (args.targets !== undefined) body.targets = args.targets;
        if (args.order !== undefined) body.order = args.order;
        if (args.limit !== undefined) body.limit = args.limit;
        if (args.offset !== undefined) body.offset = args.offset;
        const request = parseChronicleQueryBody(body, '');
        const result = queryChronicle(ndb, request, { userId: rt.deps.auth.userId });
        return {
          rows: result.rows,
          meta: { total: result.total, offset: request.offset, limit: request.limit },
        };
      }),
  );

}
