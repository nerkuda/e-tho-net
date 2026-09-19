/**
 * layers.ts — MCP-инструменты области «registerLayersReadTools, registerLayersWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { z } from 'zod';
import { closeNetworkDb, openNetworkDb } from '../../db/network-db.js';
import { createLayer, deleteLayerWithEvents, getLayerSnapshot, layerSubtreeIds, listLayers, setSessionLayer, updateLayer } from '../../domain/layer-service.js';
import { layerDiffDoc, resolveDiffTarget, structuralLayerDiff } from '../../domain/layer-diff-service.js';
import { mergeLayer } from '../../domain/merge-service.js';
import type { MergeSelection } from '../../domain/merge-service.js';
import { BRANCHABLE_TABLES } from '../../db/layer-chain.js';
import type { BranchableTable } from '../../db/layer-write.js';
import { BASE_LAYER_ID, EtnError, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { LayerMergeReport } from '@etn/shared';
import { search } from '../../domain/search-service.js';
import { recordLayerActivity } from '../../domain/activity-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../../domain/chronicle-service.js';
import { auditAgentCall, emitAgentEvent, mcpLayerClientId, openMemberNetworkBase, requireWritable, requireWriteBudget, resolveRuntimeLayer, runTool, runWriteTool } from '../context.js';
import { NetworkId, LayerId, ExpectedVersion } from './shared.js';

export function registerLayersReadTools(mcp: McpServer, rt: McpRuntime): void {
  const LayersListSchema = z.object({
    network_id: NetworkId,
    include_service: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.layers.list',
    {
      title: 'Список слоёв',
      description:
        'All layers of the network with hierarchy metadata: id, parent_id, title, comment, git_branch, ' +
        'depth, children_count (the DELETE cascade confirmation) and `current` — true on the calling key\'s ' +
        'own session layer. Service (reserve) layers are hidden unless `include_service: true`.',
      inputSchema: LayersListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const current = resolveRuntimeLayer(rt, args.network_id);
        return listLayers(ndb, { includeService: args.include_service, currentLayerId: current.id });
      }),
  );

  // etn.layers.diff / etn.layers.diff_doc — S11 read tools, the two views of
  // «чем слой отличается» (13-layers.md §10.3, §15): the structural link
  // diff and the deterministic textual documents. Both read on two
  // connections — the layer's own context and its parent's.
  const LayersDiffSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  });
  mcp.registerTool(
    'etn.layers.diff',
    {
      title: 'Структурное отличие слоя',
      description:
        'Structural diff of a layer against its parent: `links` — added/removed/type_changed/reparented ' +
        '(1:1 swaps of the parent link)/reorder_collapsed (position-only batches); `overridden` — the ids ' +
        'physically present in the layer (shadow rows, inserts and tombstones). The textual diff ' +
        '(`etn.layers.diff_doc`) is blind to all of these — use both.',
      inputSchema: LayersDiffSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, target.id);
        return structuralLayerDiff(layerNdb, targetNdb, layer, target);
      }),
  );
  mcp.registerTool(
    'etn.layers.diff_doc',
    {
      title: 'Содержательное отличие слоя (документы)',
      description:
        'Textual diff payload of a layer against its parent: two deterministically assembled markdown ' +
        'documents (`layer_doc`/`target_doc`) for a plain line-by-line comparison (all visible thoughts ' +
        'ordered by id).',
      inputSchema: LayersDiffSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff_doc'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, target.id);
        return layerDiffDoc(layerNdb, targetNdb, layer, target);
      }),
  );

  // =========================================================================
  // `etn.chronicle.query` (задача 6d45ab37, спека 52767bdf, P1-паритет
  // MCP↔REST `POST /chronicle/query`). Прокси над domain
  // `parseChronicleQueryBody` + `queryChronicle` с резолвом имён типов.
  // =========================================================================

  // Объединённая схема — повторяет ключи REST `POST /chronicle/query`
  // (docs/03-server-api.md §20). Имена типов и имён свойств резолвятся
  // хелперами ниже, как в `etn.thoughts.query`/`search` (задача d5ab1630).
}

export function registerLayersWriteTools(mcp: McpServer, rt: McpRuntime): void {
  const LayersCreateSchema = z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    /** Defaults to the calling key's current session layer (§2.3). */
    parent_id: LayerId.optional(),
    comment: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.layers.create',
    {
      title: 'Создать слой',
      description:
        'Create a layer under the given parent — defaults to the calling key\'s current session layer. ' +
        '`comment` is strongly encouraged: it is how the next agent understands the layer\'s purpose. ' +
        'Depth is capped at 4 ordinary layers above the base. Does not switch the session — call ' +
        '`etn.layers.select` for that.',
      inputSchema: LayersCreateSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Resolve the session layer once and reuse it both as the implicit
        // parent (§2.3) and as the `current` reference for the response:
        // creating a layer is not the same as switching to it (fix for
        // error 9b159e7a — created.current was always `true`).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const parent = args.parent_id ?? sessionLayer.id;
        const layer = createLayer(ndb, {
          parentId: parent,
          title: args.title,
          comment: args.comment ?? null,
          gitBranch: args.git_branch ?? null,
          createdBy: rt.deps.auth.userId,
        });
        // Journal row, mirroring the REST POST /layers route: the snapshot
        // layer is the calling key's session layer (creating does not switch).
        recordLayerActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'created',
          layer,
          layerId: sessionLayer.id,
        });
        auditAgentCall(rt, 'etn.layers.create', args.network_id, 'layer', layer.id, {
          title: args.title,
          parent_id: parent,
        });
        return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
      }),
  );

  const LayersUpdateSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    title: z.string().min(1).optional(),
    comment: z.string().nullable().optional(),
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.layers.update',
    {
      title: 'Переименовать слой / изменить комментарий',
      description:
        'Rename a layer and/or edit its comment. The base layer\'s title is fixed («Основа») — renaming it ' +
        'is a VALIDATION_ERROR; editing its comment is allowed. `expected_version` — the usual optimistic ' +
        'lock (409 VERSION_CONFLICT on mismatch).',
      inputSchema: LayersUpdateSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        if (args.title === undefined && args.comment === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'нечего менять: передайте title и/или comment.',
            { fields: ['title', 'comment'] },
          );
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Renaming/editing a layer does not switch the session: `current`
        // reflects the calling key's real session layer, not the edited
        // layer (same pattern as the createLayer fix 9b159e7a).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const layer = updateLayer(
          ndb,
          args.layer_id,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          },
          args.expected_version,
          rt.deps.auth.userId,
        );
        // Journal row, mirroring the REST PATCH /layers/:id route: the
        // snapshot layer is the session layer (renaming does not switch).
        recordLayerActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'updated',
          layer,
          layerId: sessionLayer.id,
        });
        auditAgentCall(rt, 'etn.layers.update', args.network_id, 'layer', layer.id, {
          title: args.title,
          comment: args.comment,
        });
        return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
      }),
  );

  const LayersDeleteSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    /** Required confirmation once the layer has descendants (§2.4) — the
     * `children_count` the agent just read from `etn.layers.list`. */
    cascade: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.layers.delete',
    {
      title: 'Удалить слой',
      description:
        'Delete a layer together with its whole descendant subtree. A layer with descendants requires ' +
        '`cascade` to echo `children_count` from `etn.layers.list` (mismatch → 409, missing with living ' +
        'descendants → 422 with the actual count). Physically removes every shadow row and tombstone of ' +
        'the subtree (nothing is transferred to the parent) and auto-purges the trash. The base layer ' +
        'cannot be deleted.',
      inputSchema: LayersDeleteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        // Close the doomed layers' pooled connections first (mirrors the REST
        // route): their temp `layer_chain` would otherwise keep referencing
        // deleted layers.
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Snapshot of the doomed layer BEFORE the cascade deletes its row —
        // it goes to the journal (mirrors the REST DELETE /layers/:id route),
        // and the parent id says where the subtree sessions were re-pointed.
        const parentRow = getLayerSnapshot(ndb, args.layer_id);
        const subtreeIds = layerSubtreeIds(ndb, args.layer_id);
        for (const id of subtreeIds) {
          if (id !== BASE_LAYER_ID) {
            closeNetworkDb(args.network_id, id);
          }
        }
        const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id) ?? 0;
        const result = deleteLayerWithEvents(ndb, args.layer_id, args.cascade, switchedAtSeq);
        // Per-row realtime events of the trash auto-purge — journaled rows
        // are intentionally absent for them: the REST DELETE /layers/:id
        // route records only the layer's own row (parity).
        for (const id of result.deleted_thought_ids) {
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
        }
        for (const id of result.deleted_link_ids) {
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
        }
        if (parentRow) {
          // Journal snapshot layer — where the deleted subtree's sessions were
          // re-pointed (same choice as the REST route, 13-layers.md §2.4).
          recordLayerActivity(ndb, {
            networkId: args.network_id,
            userId: rt.deps.auth.userId,
            action: 'deleted',
            layer: { id: args.layer_id, title: parentRow.title },
            layerId: parentRow.parent_id ?? BASE_LAYER_ID,
          });
        }
        auditAgentCall(rt, 'etn.layers.delete', args.network_id, 'layer', args.layer_id, {
          cascade: args.cascade,
          deleted: result.deleted,
        });
        return {
          deleted: result.deleted,
          purged: result.purged,
          skipped: result.skipped,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LayersSelectSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  });
  mcp.registerTool(
    'etn.layers.select',
    {
      title: 'Переключить текущий слой',
      description:
        'Switch the calling API key\'s current session layer: every later call of this key — reads and ' +
        'writes alike — runs in the new layer\'s context. A service (reserve) layer cannot be selected; ' +
        'selecting the current layer again is a no-op. `etn.changes.list` forces a full resync once ' +
        '`since_seq` predates this switch.',
      inputSchema: LayersSelectSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.select'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id) ?? 0;
        const layer = setSessionLayer(
          ndb,
          rt.deps.auth.userId,
          mcpLayerClientId(rt),
          args.layer_id,
          switchedAtSeq,
        );
        // No activity_log row: switching the session does not change the
        // layer entity itself — the REST `/select` route does not journal it
        // either (требование b0c7a57c covers entity mutations only).
        auditAgentCall(rt, 'etn.layers.select', args.network_id, 'layer', layer.id, {});
        return { ...layer, request_id: String(extra.requestId) };
      }),
  );

  const LayersMergeSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    /** Closed subset `{ table: [logical row ids…] }` — omit for a full merge. */
    tables: z.record(z.string(), z.array(z.string().min(1))).optional(),
  });
  mcp.registerTool(
    'etn.layers.merge',
    {
      title: 'Слить слой в родителя',
      description:
        'Merge a layer into its parent — full (default) or a closed partial subset `tables: { <branchable ' +
        'table>: [row ids…] }`. A replay conflict or an unclosed partial selection rejects the WHOLE ' +
        'operation with VALIDATION_ERROR (`conflicts`/`missing_closure`) — no partial application. Returns ' +
        '{ applied, skipped, reorder_collapsed, reserve_layer_id (auto-created pre-merge state for manual ' +
        'rollback), purged }. See prompt etn.how_to_merge_partial.',
      inputSchema: LayersMergeSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.merge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        let selection: MergeSelection | undefined;
        if (args.tables !== undefined) {
          selection = {};
          for (const [table, ids] of Object.entries(args.tables)) {
            if (!(BRANCHABLE_TABLES as readonly string[]).includes(table)) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `неизвестная ветвимая таблица «${table}».`,
                { field: 'tables', table, allowed: BRANCHABLE_TABLES },
              );
            }
            selection[table as BranchableTable] = ids;
          }
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const result = mergeLayer(ndb, args.layer_id, selection, rt.deps.auth.userId);

        // No own activity_log row for the merge — parity with the REST merge
        // route: mergeLayer already rolled the layer's journal rows up into
        // the base (autoRollupLayerActivity, задача 6bcccd2b), and REST does
        // not record a separate `layer` row for the merge operation itself.

        // Exactly one `layer.merged` event per merge (04-realtime.md §11.4),
        // attributed to the merge target — not the agent's session layer.
        const report: LayerMergeReport = {
          applied: result.applied,
          skipped: result.skipped,
          reorder_collapsed: result.reorder_collapsed,
          reserve_layer_id: result.reserve_layer_id,
          purged: result.purged,
          activity_rollup: result.activity_rollup,
        };
        emitAgentEvent(
          rt,
          args.network_id,
          'layer.merged',
          { ...report, layer: result.merged_layer, target_layer: result.target_layer },
          extra.requestId,
          result.target_layer.id,
        );
        // The trash auto-purge victims are ordinary deletions outside the
        // merge row set — realtime only, no journal rows (as the REST merge
        // route; the journal side of the merge is the auto-rollup above).
        for (const id of result.deleted_thought_ids) {
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
        }
        for (const id of result.deleted_link_ids) {
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
        }
        auditAgentCall(rt, 'etn.layers.merge', args.network_id, 'layer', args.layer_id, {
          tables: args.tables,
          applied: report.applied,
        });
        return { ...report, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // `etn.thoughts.bulk_update` (задача 6d45ab37, спека 77502d93, P1-паритет
  // MCP↔REST `POST /thoughts/batch`). Групповые операции над мыслями —
  // одна запись бюджета на ВЕСЬ вызов; `failures[]` для отдельных id.
}
