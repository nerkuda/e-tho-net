/**
 * changes.ts — MCP-инструменты области «registerChangesListTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { openNetworkDb } from '../../db/network-db.js';
import { resolveSessionLayer, resolveSessionSwitchSeq } from '../../domain/layer-service.js';
import { isEventVisibleInLayer } from '../../realtime/layer-visibility.js';
import { EtnError, MCP_TOOL_ANNOTATIONS, REALTIME_DEFAULTS } from '@etn/shared';
import type { McpChangeEntry, McpChangesListResult, Network } from '@etn/shared';
import { search } from '../../domain/search-service.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { assertNetworkAccess, mcpLayerClientId, openMemberNetwork, runTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerChangesListTool(mcp: McpServer, rt: McpRuntime): void {
  const ChangesListSchema = z.object({
    network_id: NetworkId,
    since_seq: z.number().int().min(0),
    limit: z.number().int().min(1).max(REALTIME_DEFAULTS.EVENT_LOG_MAX_ROWS).optional(),
  });
  const DEFAULT_CHANGES_LIMIT = 1000;
  mcp.registerTool(
    'etn.changes.list',
    {
      title: 'Дельта событий',
      description:
        'Delta feed over the real-time `event_log` for long-lived agents with their own cache: events ' +
        'with `seq > since_seq`, ascending, capped at `limit` (default 1000); `cursor` echoes the retained ' +
        'window. `audience: "user"` events are filtered to the caller\'s own; the delta respects the ' +
        'caller\'s session layer. `truncated: true` — `since_seq` predates the retained window or the ' +
        'session\'s last layer switch: do a full resync (`etn.thoughts.search` + `etn.thoughts.get`) ' +
        'before resuming. Each entry carries `layer_id`.',
      inputSchema: ChangesListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.changes.list'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        assertNetworkAccess(rt, args.network_id);

        const limit = args.limit ?? DEFAULT_CHANGES_LIMIT;
        const minSeq = rt.deps.systemDb.getMinEventSeq(args.network_id);
        const maxSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id);
        const events = rt.deps.systemDb.readEventsAfter(
          args.network_id,
          args.since_seq,
          limit,
        );
        const authUserId = rt.deps.auth.userId;

        // Task S10 (13-layers.md §12): the delta must respect the caller's
        // session layer, same as the WebSocket gateway — keyed by the calling
        // API key ({@link mcpLayerClientId}), the same coordinate every other
        // read/write tool now resolves through `openMemberNetwork`.
        const baseNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger);
        const clientId = mcpLayerClientId(rt);
        const sessionLayer = resolveSessionLayer(baseNdb, authUserId, clientId);
        const switchedAtSeq = resolveSessionSwitchSeq(baseNdb, authUserId, clientId);
        const layerNdb =
          sessionLayer.id === baseNdb.layerId
            ? baseNdb
            : openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, sessionLayer.id);

        const filtered: McpChangeEntry[] = events
          .filter((e) => e.audience === 'network' || e.actor.user_id === authUserId)
          .filter((e) => e.audience === 'user' || isEventVisibleInLayer(layerNdb, e, sessionLayer.id))
          .map((e) => ({
            type: e.type,
            seq: e.seq,
            ts: e.ts,
            data: e.data,
            audience: e.audience,
            layer_id: e.layer_id,
          }));
        // `truncated` fires when an explicit (non-zero) `since_seq` is either
        // older than the first retained row, or older than this session's
        // last layer switch (`switched_at_seq`, migration 028 — a delta
        // spanning a switch mixes two different layers' visibility filters,
        // 13-layers.md §12). A zero `since_seq` ("from the start") is never
        // truncated by either check; an empty buffer is not truncated by the
        // window check — nothing was lost.
        const truncated =
          args.since_seq !== 0 &&
          ((minSeq !== null && args.since_seq < minSeq - 1) ||
            (switchedAtSeq > 0 && args.since_seq < switchedAtSeq));

        return {
          network_id: args.network_id,
          cursor: { min_seq: minSeq, max_seq: maxSeq },
          events: filtered,
          truncated,
          limit,
        } satisfies McpChangesListResult;
      }),
  );

}
