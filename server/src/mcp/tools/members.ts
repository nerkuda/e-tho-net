/**
 * members.ts — MCP-инструменты области «registerMembersListTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { openMemberNetwork, runTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerMembersListTool(mcp: McpServer, rt: McpRuntime): void {
  const MembersListSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.members.list',
    {
      title: 'Участники сети',
      description:
        'Список участников сети (user_id, display_name, role, joined_at). Паритет ' +
        'с `GET /networks/{id}/members`. Доступ — участники или глобальный админ.',
      inputSchema: MembersListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.members.list'],
    },
    (args) =>
      runTool(async () => {
        // openMemberNetwork сам бросает FORBIDDEN, если ключ не привязан к сети.
        openMemberNetwork(rt, args.network_id);
        const rows = rt.deps.systemDb.listNetworkMembers(args.network_id);
        return {
          members: rows.map((r) => ({
            user_id: r.user_id,
            display_name: r.display_name,
            role: r.role,
            joined_at: r.added_at,
          })),
        };
      }),
  );

  // =========================================================================
  // Mutating tools (§4.2) — domain services + real-time events + audit log
  // =========================================================================

  // ---- Layers (task S10, 13-layers.md §10.2) — paritet with REST §5a -------
  // All five run on the base-layer connection (`layers`/`session_layers` are
  // not branchable, §3), mirroring `routes/layers.ts` line for line.

}
