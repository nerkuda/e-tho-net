/**
 * export.ts — MCP-инструменты области «registerExportTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';

import { MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { ExportFormat } from '@etn/shared';
import { exportToMarkdown, getExportJobContent, startExportJob } from '../../domain/export-service.js';
import { ExportSubgraph } from '../../contracts.js';
import { subgraph } from '../../domain/graph-traversal.js';
import { openMemberNetwork, runTool } from '../context.js';

export function registerExportTool(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.export.subgraph',
    {
      title: 'Экспорт подграфа',
      description:
        'Render the radius-bounded subgraph around seeds as a Markdown (`markdown`, default), HTML or ' +
        '`.etnx` (zip-архив с мыслями, связями, типами, комментариями, вложениями — задача e488f4c1, ' +
        '0.7.2). Для `etnx` опции `include_types`/`include_attachments`/`include_chronology`/`include_subtree` ' +
        'передаются через `etnx_options`. `format: "etnx"` возвращает base64-строку архива в `content_b64`.',
      inputSchema: ExportSubgraph.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.export.subgraph'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const format: ExportFormat = args.format ?? 'markdown';
        const result = subgraph(ndb, args.seed_ids, args.radius, {
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        if (format === 'markdown') {
          const content = exportToMarkdown(ndb, result.nodes);
          return { format, truncated: result.truncated, content };
        }
        if (format === 'etnx') {
          const job = await startExportJob(ndb, result.nodes, format, {
            etnx: args.etnx_options ?? {},
            source: {
              network_id: args.network_id,
              network_name: args.network_id,
              user_id: rt.deps.auth.userId,
            },
          });
          const downloaded = getExportJobContent(job.job_id, format);
          if (downloaded === null) {
            throw new Error('ETN error [INTERNAL]: export content unavailable');
          }
          if (typeof downloaded.body === 'string') {
            throw new Error(
              'ETN error [INTERNAL]: expected binary export content, got string',
            );
          }
          return {
            format,
            truncated: result.truncated,
            content_b64: downloaded.body.toString('base64'),
            size: downloaded.body.length,
          };
        }
        // html
        const job = await startExportJob(ndb, result.nodes, format, {
          source: {
            network_id: args.network_id,
            network_name: args.network_id,
            user_id: rt.deps.auth.userId,
          },
        });
        const downloaded = getExportJobContent(job.job_id, format);
        if (downloaded === null) {
          throw new Error('ETN error [INTERNAL]: export content unavailable');
        }
        if (typeof downloaded.body !== 'string') {
          throw new Error(
            'ETN error [INTERNAL]: expected textual export content, got binary',
          );
        }
        return { format, truncated: result.truncated, content: downloaded.body };
      }),
  );

}
