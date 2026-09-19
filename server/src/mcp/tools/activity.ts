/**
 * activity.ts — MCP-инструменты области «registerActivityTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS, validateTypeRoles } from '@etn/shared';
import { ACTIVITY_LIMIT_MAX, listActivity, rollupActivity, truncateActivity } from '../../domain/activity-service.js';
import { ActivityList, ActivityRollup, ActivityTruncate } from '../../contracts.js';
import { auditAgentCall, openMemberNetwork, requireWritable, requireWriteBudget, runTool, runWriteTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerActivityTools(mcp: McpServer, rt: McpRuntime): void {
  const ActivityListSchema = z.object({
    network_id: NetworkId,
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    user_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    limit: z.number().int().positive().max(ACTIVITY_LIMIT_MAX).optional(),
    offset: z.number().int().nonnegative().optional(),
  });
  mcp.registerTool(
    'etn.activity.list',
    {
      title: 'Лента журнала активности',
      description:
        'Read the activity log of a network: one row per mutating operation by a network member — ' +
        'creation, update, delete, trash/restore of a thought, link, type, property, comment, attachment ' +
        'or layer; `entity_title` is a snapshot at the moment of the event. Captures (`edit.*`) are not ' +
        'recorded. Filters combine with AND; sorted by `occurred_at_ms DESC`; paginated (`limit` default ' +
        '50, max 200, + `offset`).',
      inputSchema: ActivityList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = listActivity(ndb, {
          networkId: args.network_id,
          from_ms: args.from_ms,
          to_ms: args.to_ms,
          user_id: args.user_id,
          entity_type: args.entity_type,
          entity_id: args.entity_id,
          limit: args.limit,
          offset: args.offset,
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

  // ---- activity.rollup / activity.truncate (задача 6bcccd2b, требование
  // 76443b7e «свёртка» и 9921a32b «обрезка», стандарт 9e5cff3f — паритет
  // с REST `POST /activity/rollup` и `POST /activity/truncate`).

  const ActivityRollupSchema = z.object({
    network_id: NetworkId,
    until_ms: z.number().int().nonnegative(),
  });
  mcp.registerTool(
    'etn.activity.rollup',
    {
      title: 'Свёртка журнала активности',
      description:
        'Roll up the activity log of a network up to `until_ms`: for each live `(entity_type, entity_id)` ' +
        'only the earliest creation/update and the latest update stay; a `deleted`/`trashed` event up to ' +
        '`until_ms` alone remains. IRREVERSIBLE; runs in one SQLite transaction. Returns `{ removed, kept }`.',
      inputSchema: ActivityRollup.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.rollup'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = rollupActivity(ndb, args.network_id, args.until_ms);
        auditAgentCall(rt, 'etn.activity.rollup', args.network_id, 'network', args.network_id, {
          until_ms: args.until_ms,
          removed: result.removed,
          kept: result.kept,
        });
        return { ...result, request_id: String(extra.requestId) };
      }),
  );

  const ActivityTruncateSchema = z.object({
    network_id: NetworkId,
    until_ms: z.number().int().nonnegative(),
  });
  mcp.registerTool(
    'etn.activity.truncate',
    {
      title: 'Обрезка журнала активности',
      description:
        'Hard-truncate the activity log of a network up to `until_ms`: every row with ' +
        '`occurred_at_ms <= until_ms` is deleted, including creation and deletion records. ' +
        'IRREVERSIBLE; runs in one SQLite transaction. Returns `{ removed }`.',
      inputSchema: ActivityTruncate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.truncate'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = truncateActivity(ndb, args.network_id, args.until_ms);
        auditAgentCall(rt, 'etn.activity.truncate', args.network_id, 'network', args.network_id, {
          until_ms: args.until_ms,
          removed: result.removed,
        });
        return { ...result, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // 0.7.2 — task ba024a45: networks.write / networks.delete / instructions.
  // =========================================================================

  // ---------------------------------------------------------------------------
  // этон.networks.write — upsert: создаёт сеть, если `network_id` не передан;
  // иначе патчит существующую (права владельца/админа).
  //
  // Контракт повторяет REST `POST /networks` + `PATCH /networks/{id}` в одном
  // фасаде — тело частично перекрывается, но `type_roles` принимает явный
  // `null` для снятия роли. Невалидные ключи `type_roles` →
  // `VALIDATION_ERROR` на этапе `validateTypeRoles`; несуществующий id типа
  // → `VALIDATION_ERROR` через `networkService.validateTypeRoles`.
  // ---------------------------------------------------------------------------
}

