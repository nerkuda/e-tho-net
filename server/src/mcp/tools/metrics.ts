/**
 * metrics.ts — MCP-инструменты области «registerMetricsTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { EtnError, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { McpMetricsReadsResult, McpMetricsToolsResult, Network } from '@etn/shared';
import { search } from '../../domain/search-service.js';
import { clampReadMetricsParams, getColdReads, getTopReads } from '../../domain/read-metrics-service.js';
import { thoughtTypeCatalog } from '../catalogs.js';
import { subgraph } from '../../domain/graph-traversal.js';
import { assertNetworkAccess, openMemberNetwork, runTool } from '../context.js';
import { NetworkId } from './shared.js';

export function registerMetricsTools(mcp: McpServer, rt: McpRuntime): void {
  const MetricsReadsSchema = z.object({
    network_id: NetworkId,
    kind: z.enum(['top', 'cold']).optional(),
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    include_inactive: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.metrics.reads',
    {
      title: 'Метрики чтений мыслей',
      description:
        'Per-thought read counters collected by the MCP read tools. `kind: "top"` (default) — most-read ' +
        'thoughts (`reads_count DESC, last_read_at DESC`); `kind: "cold"` — never read, or (with `since`) ' +
        'not read since the cutoff, ordered `updated_at DESC` so the freshest un-touched nodes come first. ' +
        'Counted by `etn.thoughts.get`, `subgraph`, `query`, `search` and `etn.networks.structure`.',
      inputSchema: MetricsReadsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.metrics.reads'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        assertNetworkAccess(rt, args.network_id);
        const { kind, limit } = clampReadMetricsParams({
          kind: args.kind,
          limit: args.limit,
        });
        const includeInactive = args.include_inactive === true;
        const since = kind === 'cold' ? args.since : undefined;
        const ndb = openMemberNetwork(rt, args.network_id);
        const items =
          kind === 'cold'
            ? getColdReads(ndb, { limit, since, includeInactive })
            : getTopReads(ndb, { limit, includeInactive });
        return {
          network_id: args.network_id,
          kind,
          since: since ?? null,
          limit,
          items,
          thought_types: thoughtTypeCatalog(ndb, items.map((i) => i.type_id)),
        } satisfies McpMetricsReadsResult;
      }),
  );

  // etn.metrics.tools — 940a499d read tool (операция 254ba4db). Aggregate over
  // the `_system.db` table `mcp_tool_call_metrics` written by the shared
  // registration wrapper (`mcp/server.ts`): how often each tool is called and
  // how often it errors. The evidence base for roster decisions — a tool with
  // `calls_count = 0` over a period is a removal candidate, one with
  // `errors_count / calls_count > 0.5` has an unclear contract/description.
  // Admin sees every row; a regular member sees only the rows of their own
  // networks plus their own network-less calls.
  const MetricsToolsSchema = z.object({
    network_id: NetworkId.optional(),
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    group_by: z.enum(['tool', 'tool+network', 'tool+key']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });
  mcp.registerTool(
    'etn.metrics.tools',
    {
      title: 'Телеметрия вызовов инструментов',
      description:
        'Aggregate call counters per MCP tool (successes and errors) from `mcp_tool_call_metrics`. ' +
        '`group_by`: "tool" (default) | "tool+network" | "tool+key"; `from_ms`/`to_ms` bound `last_call_at` ' +
        '(the table is an aggregate — the window bounds the observed interval). Ordered by `calls_count ' +
        'DESC`; `limit` default 50, max 200. The owner (admin) sees everything; a regular member sees ' +
        'only the rows of their own networks plus their own network-less calls. Verdicts: `calls_count = 0` ' +
        'over a period — removal candidate; `errors_count / calls_count > 0.5` — unclear tool, revise its ' +
        'contract/description.',
      inputSchema: MetricsToolsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.metrics.tools'],
    },
    (args) =>
      runTool(async () => {
        if (args.network_id !== undefined) {
          assertNetworkAccess(rt, args.network_id);
        }
        const groupBy = args.group_by ?? 'tool';
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const isAdmin = rt.deps.auth.isAdmin;
        const items = rt.deps.systemDb.aggregateToolCallMetrics({
          groupBy,
          networkId: args.network_id,
          fromMs: args.from_ms,
          toMs: args.to_ms,
          limit,
          visibleNetworks: isAdmin ? null : rt.deps.systemDb.listMemberNetworkIds(rt.deps.auth.userId),
          visibleKeyIds: isAdmin ? [] : rt.deps.systemDb.listApiKeyIdsByUser(rt.deps.auth.userId),
        });
        return { group_by: groupBy, limit, items } satisfies McpMetricsToolsResult;
      }),
  );

}
