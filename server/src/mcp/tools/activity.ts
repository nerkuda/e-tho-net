/**
 * activity.ts — MCP-инструмент «etn.activity.list».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2).
 *
 * 0.8.3 (задача 86ef2ff4): редкие операции журнала (`activity.rollup`,
 * `activity.truncate`) сняты из постоянного набора и упакованы в `etn.ops`
 * (tools/ops.ts). Здесь остаётся только частый `etn.activity.list`.
 *
 * Ошибка 5f08daee: детали фильтров/пагинации вынесены в тему гайда
 * `etn.guide { topic: "activity.list" }`; ссылка в описании — контракт,
 * который держит сторож `guard-mcp-guide-coverage.test.ts`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { listActivity, parseActivityListQuery } from '../../domain/activity-service.js';
import { ActivityList } from '../../contracts.js';
import { openMemberNetwork, runTool } from '../context.js';
import { mcpTokenContext } from './token-context.js';

export function registerActivityTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.activity.list',
    {
      title: 'Лента журнала активности',
      description:
        'Read the activity log of a network: one row per mutating operation by a network member — ' +
        'creation, update, delete, trash/restore of a thought, link, type, property, comment, attachment ' +
        'or layer; `entity_title` is a snapshot at the moment of the event. Captures (`edit.*`) are not ' +
        'recorded. Filters combine with AND; sorted by `occurred_at_ms DESC`; paginated (`limit` default ' +
        '50, max 200, + `offset`). `ast` — тело отбора профиля «события» (XOR с плоскими фильтрами). ' +
        'Детали фильтров, AST и пагинации — `etn.guide { topic: "activity.list" }`.',
      inputSchema: ActivityList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const params = parseActivityListQuery({ ...args }, '');
        // Контекст профиля «события»: первый день недели сети, часы и
        // пользователь для под-выборки «Сущность» (требование 0095daad).
        const tokenCtx = mcpTokenContext(rt, args.network_id as string, 'events');
        const result = listActivity(ndb, params, {
          userId: rt.deps.auth.userId,
          nowMs: tokenCtx.nowMs,
          ...(tokenCtx.firstDayOfWeek !== undefined ? { firstDayOfWeek: tokenCtx.firstDayOfWeek } : {}),
        });
        return {
          data: result.data,
          meta: {
            total: result.total,
            offset: result.offset,
            limit: result.limit,
          },
        };
      }),
  );
}
