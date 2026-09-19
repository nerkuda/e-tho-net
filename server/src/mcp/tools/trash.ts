/**
 * trash.ts — MCP-инструменты области «registerTrashListTool, registerTrashPurgeTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { listTrash, purgeTrash } from '../../domain/trash-service.js';
import { recordLinkActivity, recordThoughtActivity } from '../../domain/activity-service.js';
import { auditAgentCall, emitAgentEvent, openMemberNetwork, requireWritable, requireWriteBudget, runTool, runWriteTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerTrashListTool(mcp: McpServer, rt: McpRuntime): void {
  const TrashListSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.trash.list',
    {
      title: 'Корзина сети',
      description:
        'The trash of the network: every thought and link with `marked_for_deletion=true`, each with its ' +
        'precomputed blocking check — what is purgeable is visible at once. See prompt etn.how_to_purge.',
      inputSchema: TrashListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return listTrash(ndb);
      }),
  );

}

export function registerTrashPurgeTool(mcp: McpServer, rt: McpRuntime): void {
  const TrashPurgeSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.trash.purge',
    {
      title: 'Очистить корзину',
      description:
        '«Удалить всё, что возможно»: physically delete every marked thought/link for which the blocking ' +
        'check reports nothing; blocked ones are skipped silently. Returns { purged, skipped } — a ' +
        'non-empty `skipped` also carries `how_to`. See prompt etn.how_to_purge.',
      inputSchema: TrashPurgeSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.purge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        // Снимки помеченных на удаление строк ДО физического удаления —
        // после purgeTrash их уже нет, а журналу нужен снимок на момент
        // операции (тот же ход, что в REST POST /trash/purge).
        const trash = listTrash(ndb);
        const thoughtSnapshots = new Map(trash.thoughts.map((t) => [t.id, t]));
        const linkSnapshots = new Map(trash.links.map((l) => [l.id, l]));
        const { purged, skipped, deleted_thought_ids, deleted_link_ids } = purgeTrash(ndb);
        for (const id of deleted_thought_ids) {
          const snapshot = thoughtSnapshots.get(id);
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
          if (snapshot !== undefined) {
            recordThoughtActivity(ndb, {
              networkId: args.network_id,
              userId: rt.deps.auth.userId,
              action: 'deleted',
              thought: snapshot,
              layerId: ndb.layerId,
            });
          }
        }
        for (const id of deleted_link_ids) {
          const snapshot = linkSnapshots.get(id);
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
          if (snapshot !== undefined) {
            recordLinkActivity(ndb, {
              networkId: args.network_id,
              userId: rt.deps.auth.userId,
              action: 'deleted',
              link: snapshot,
              layerId: ndb.layerId,
            });
          }
        }
        auditAgentCall(rt, 'etn.trash.purge', args.network_id, 'network', args.network_id, {
          purged,
          skipped,
        });
        return {
          purged,
          skipped,
          // Hint-навигатор уровня 2 (ADR b2eebf8b): непустой skipped значит,
          // что часть корзины заблокирована — промпт объясняет, что делать.
          ...(skipped > 0 ? { how_to: 'etn.how_to_purge' } : {}),
        };
      }),
  );

}
