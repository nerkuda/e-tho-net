/**
 * layers.ts — MCP-инструменты области «registerLayersReadTools,
 * registerLayersWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2).
 *
 * 0.8.3 (задача 86ef2ff4): редкие операции слоёв (`diff`, `diff_doc`, `create`,
 * `update`, `delete`, `merge`) сняты из постоянного набора и упакованы в
 * `etn.ops` (tools/ops.ts). Здесь остаются только частые `etn.layers.list` и
 * `etn.layers.select`.
 *
 * Веха 8 (задача c9d5f21e): схемы входа — единые контракты из
 * `contracts.ts`, общие с REST-роутами; одинаковый невалидный вход даёт
 * одинаковые код и сообщение в обоих фасадах.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { listLayers, setSessionLayer } from '../../domain/layer-service.js';
import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import {
  mcpLayerClientId,
  mcpWriteFx,
  openMemberNetworkBase,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';
import { LayersList, LayersSelect } from '../../contracts.js';

export function registerLayersReadTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.layers.list',
    {
      title: 'Список слоёв',
      description:
        'All layers of the network with hierarchy metadata: id, parent_id, title, comment, git_branch, ' +
        "depth, children_count (the DELETE cascade confirmation) and `current` — true on the calling key's " +
        'own session layer. Service (reserve) layers are hidden unless `include_service: true`.',
      inputSchema: LayersList.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const current = resolveRuntimeLayer(rt, args.network_id);
        return listLayers(ndb, {
          includeService: args.include_service,
          currentLayerId: current.id,
        });
      }),
  );
}

export function registerLayersWriteTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.layers.select',
    {
      title: 'Переключить текущий слой',
      description:
        "Switch the calling API key's current session layer: every later call of this key — reads and " +
        "writes alike — runs in the new layer's context. A service (reserve) layer cannot be selected; " +
        'selecting the current layer again is a no-op. `etn.changes.list` forces a full resync once ' +
        '`since_seq` predates this switch.',
      inputSchema: LayersSelect.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.select'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id) ?? 0;
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const layer = runWrite(ndb, fx, () => {
          const selected = setSessionLayer(
            ndb,
            rt.deps.auth.userId,
            mcpLayerClientId(rt),
            args.layer_id,
            switchedAtSeq,
          );
          return {
            result: selected,
            audit: {
              action: 'etn.layers.select',
              targetType: 'layer',
              targetId: selected.id,
              details: {},
            },
          };
        });
        return { ...layer, request_id: String(extra.requestId) };
      }),
  );
}
