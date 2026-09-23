/**
 * trash.ts — MCP-инструменты области «registerTrashListTool, registerTrashPurgeTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * Веха 9 (задача 8b2efe2d): очистка корзины исполняется через доменную
 * обёртку {@link runWrite} — весь проход одна транзакция (требование
 * 3269a025, ошибка ac8a684b), события и журнал — из результата очистки,
 * после коммита.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { listTrash, purgeTrash } from '../../domain/trash-service.js';
import { TrashList, TrashPurge } from '../../contracts.js';
import { dropVisualFields, toCompactLink, withSanitizedIcon } from '../catalogs.js';
import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';

export function registerTrashListTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.trash.list',
    {
      title: 'Корзина сети',
      description:
        'The trash of the network: every thought and link with `marked_for_deletion=true`, each with its ' +
        'precomputed blocking check — what is purgeable is visible at once. See prompt etn.how_to_purge.',
      inputSchema: TrashList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const trash = listTrash(ndb);
        // MCP-проекция списка — compact: визуальные поля мыслей снимаются,
        // `icon` санитайзится и остаётся; стилевые оверрайды связей — через
        // `toCompactLink`. `blocked`/`blocking` сохраняются.
        return {
          thoughts: trash.thoughts.map((t) => dropVisualFields(withSanitizedIcon(t))),
          links: trash.links.map((l) => toCompactLink(l)),
        };
      }),
  );
}

export function registerTrashPurgeTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.trash.purge',
    {
      title: 'Очистить корзину',
      description:
        '«Удалить всё, что возможно»: physically delete every marked thought/link for which the blocking ' +
        'check reports nothing; blocked ones are skipped silently. Returns { purged, skipped } — a ' +
        'non-empty `skipped` also carries `how_to`. See prompt etn.how_to_purge.',
      inputSchema: TrashPurge.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.purge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        // Весь проход — одна обёрточная транзакция (требование 3269a025):
        // сбой посреди не оставляет частичного удаления. События `*.deleted`
        // и журнал — из результата очистки, после коммита; аудит — одна
        // строка на вызов, из результата.
        const { purged, skipped } = runWrite(ndb, fx, () => {
          const swept = purgeTrash(ndb);
          return {
            ...swept,
            audit: {
              action: 'etn.trash.purge',
              targetType: 'network',
              targetId: args.network_id,
              details: { purged: swept.result.purged, skipped: swept.result.skipped },
            },
          };
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
