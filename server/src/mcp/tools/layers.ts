/**
 * layers.ts — MCP-инструменты области «registerLayersReadTools, registerLayersWriteTools».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 *
 * Веха 8 (задача c9d5f21e): схемы входа — единые контракты из
 * `contracts.ts`, общие с REST-роутами; одинаковый невалидный вход даёт
 * одинаковые код и сообщение в обоих фасадах.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { closeNetworkDb, openNetworkDb } from '../../db/network-db.js';
import {
  createLayer,
  deleteLayerWithEvents,
  getLayerSnapshot,
  layerSubtreeIds,
  listLayers,
  setSessionLayer,
  updateLayer,
} from '../../domain/layer-service.js';
import {
  layerDiffDoc,
  resolveDiffTarget,
  structuralLayerDiff,
} from '../../domain/layer-diff-service.js';
import { mergeLayer } from '../../domain/merge-service.js';
import type { MergeSelection } from '../../domain/merge-service.js';
import { BRANCHABLE_TABLES } from '../../db/layer-chain.js';
import type { BranchableTable } from '../../db/layer-write.js';
import { BASE_LAYER_ID, EtnError, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import type { LayerMergeReport } from '@etn/shared';
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
import {
  LayersCreate,
  LayersDelete,
  LayersDiff,
  LayersDiffDoc,
  LayersList,
  LayersMerge,
  LayersSelect,
  LayersUpdate,
} from '../../contracts.js';

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

  // etn.layers.diff / etn.layers.diff_doc — S11 read tools, the two views of
  // «чем слой отличается» (13-layers.md §10.3, §15): the structural link
  // diff and the deterministic textual documents. Both read on two
  // connections — the layer's own context and its parent's.
  mcp.registerTool(
    'etn.layers.diff',
    {
      title: 'Структурное отличие слоя',
      description:
        'Structural diff of a layer against its parent: `links` — added/removed/type_changed/reparented ' +
        '(1:1 swaps of the parent link)/reorder_collapsed (position-only batches); `overridden` — the ids ' +
        'physically present in the layer (shadow rows, inserts and tombstones). The textual diff ' +
        '(`etn.layers.diff_doc`) is blind to all of these — use both.',
      inputSchema: LayersDiff.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(
          rt.deps.dataDir,
          args.network_id,
          rt.deps.logger,
          target.id,
        );
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
      inputSchema: LayersDiffDoc.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff_doc'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(
          rt.deps.dataDir,
          args.network_id,
          rt.deps.logger,
          target.id,
        );
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
  mcp.registerTool(
    'etn.layers.create',
    {
      title: 'Создать слой',
      description:
        "Create a layer under the given parent — defaults to the calling key's current session layer. " +
        "`comment` is strongly encouraged: it is how the next agent understands the layer's purpose. " +
        'Depth is capped at 4 ordinary layers above the base. Does not switch the session — call ' +
        '`etn.layers.select` for that.',
      inputSchema: LayersCreate.schema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Resolve the session layer once and reuse it both as the implicit
        // parent (§2.3) and as the `current` reference for the response:
        // creating a layer is not the same as switching to it (fix for
        // error 9b159e7a — created.current was always `true`).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const parent = args.parent_id ?? sessionLayer.id;
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const layer = runWrite(ndb, fx, () => {
          const created = createLayer(ndb, {
            parentId: parent,
            title: args.title,
            comment: args.comment ?? null,
            gitBranch: args.git_branch ?? null,
            createdBy: rt.deps.auth.userId,
          });
          // Journal row, mirroring the REST POST /layers route: the snapshot
          // layer is the calling key's session layer (creating does not switch).
          return {
            result: created,
            activity: [{ kind: 'layer', action: 'created', layer: created }],
            audit: {
              action: 'etn.layers.create',
              targetType: 'layer',
              targetId: created.id,
              details: { title: args.title, parent_id: parent },
            },
          };
        });
        return {
          ...layer,
          current: layer.id === sessionLayer.id,
          request_id: String(extra.requestId),
        };
      }),
  );

  mcp.registerTool(
    'etn.layers.update',
    {
      title: 'Переименовать слой / изменить комментарий',
      description:
        "Rename a layer and/or edit its comment. The base layer's title is fixed («Основа») — renaming it " +
        'is a VALIDATION_ERROR; editing its comment is allowed. `expected_version` — the usual optimistic ' +
        'lock (409 VERSION_CONFLICT on mismatch).',
      inputSchema: LayersUpdate.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        if (args.title === undefined && args.comment === undefined) {
          throw new EtnError('VALIDATION_ERROR', 'нечего менять: передайте title и/или comment.', {
            fields: ['title', 'comment'],
          });
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Renaming/editing a layer does not switch the session: `current`
        // reflects the calling key's real session layer, not the edited
        // layer (same pattern as the createLayer fix 9b159e7a).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const layer = runWrite(ndb, fx, () => {
          const updated = updateLayer(
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
          return {
            result: updated,
            activity: [{ kind: 'layer', action: 'updated', layer: updated }],
            audit: {
              action: 'etn.layers.update',
              targetType: 'layer',
              targetId: updated.id,
              details: { title: args.title, comment: args.comment },
            },
          };
        });
        return {
          ...layer,
          current: layer.id === sessionLayer.id,
          request_id: String(extra.requestId),
        };
      }),
  );

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
      inputSchema: LayersDelete.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
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
        // Журнальная строка слоя идёт со снимком «куда переведены сессии»
        // (родитель удалённого поддерева) — слой для fx переопределяем.
        const fx = {
          ...mcpWriteFx(rt, args.network_id, extra.requestId),
          layerId: parentRow?.parent_id ?? BASE_LAYER_ID,
        };
        const result = runWrite(ndb, fx, () => {
          const res = deleteLayerWithEvents(ndb, args.layer_id, args.cascade, switchedAtSeq);
          return {
            result: res,
            events: [
              // Per-row realtime events of the trash auto-purge — journaled
              // rows are intentionally absent for them: the REST DELETE
              // /layers/:id route records only the layer's own row (parity).
              ...res.deleted_thought_ids.map((id) => ({
                type: 'thought.deleted' as const,
                data: { id },
              })),
              ...res.deleted_link_ids.map((id) => ({
                type: 'link.deleted' as const,
                data: { id },
              })),
            ],
            ...(parentRow === null
              ? {}
              : {
                  activity: [
                    {
                      kind: 'layer' as const,
                      action: 'deleted' as const,
                      layer: { id: args.layer_id, title: parentRow.title },
                    },
                  ],
                }),
            audit: {
              action: 'etn.layers.delete',
              targetType: 'layer',
              targetId: args.layer_id,
              details: { cascade: args.cascade, deleted: res.deleted },
            },
          };
        });
        return {
          deleted: result.deleted,
          purged: result.purged,
          skipped: result.skipped,
          request_id: String(extra.requestId),
        };
      }),
  );

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
            // No activity_log row: switching the session does not change the
            // layer entity itself — the REST `/select` route does not journal
            // it either (требование b0c7a57c covers entity mutations only).
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
      inputSchema: LayersMerge.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.merge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        let selection: MergeSelection | undefined;
        if (args.tables !== undefined) {
          selection = {};
          for (const [table, ids] of Object.entries(args.tables)) {
            if (!(BRANCHABLE_TABLES as readonly string[]).includes(table)) {
              throw new EtnError('VALIDATION_ERROR', `неизвестная ветвимая таблица «${table}».`, {
                field: 'tables',
                table,
                allowed: BRANCHABLE_TABLES,
              });
            }
            selection[table as BranchableTable] = ids;
          }
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const fx = mcpWriteFx(rt, args.network_id, extra.requestId);
        const result = runWrite(ndb, fx, () => {
          const merged = mergeLayer(ndb, args.layer_id, selection, rt.deps.auth.userId);

          // No own activity_log row for the merge — parity with the REST merge
          // route: mergeLayer already rolled the layer's journal rows up into
          // the base (autoRollupLayerActivity, задача 6bcccd2b), and REST does
          // not record a separate `layer` row for the merge operation itself.

          // Exactly one `layer.merged` event per merge (04-realtime.md §11.4),
          // attributed to the merge target — not the agent's session layer.
          const report: LayerMergeReport = {
            applied: merged.applied,
            skipped: merged.skipped,
            reorder_collapsed: merged.reorder_collapsed,
            reserve_layer_id: merged.reserve_layer_id,
            purged: merged.purged,
            activity_rollup: merged.activity_rollup,
          };
          return {
            result: merged,
            events: [
              {
                type: 'layer.merged',
                data: {
                  ...report,
                  layer: merged.merged_layer,
                  target_layer: merged.target_layer,
                },
                options: { layerId: merged.target_layer.id },
              },
              // The trash auto-purge victims are ordinary deletions outside the
              // merge row set — realtime only, no journal rows (as the REST
              // merge route; the journal side of the merge is the auto-rollup
              // above).
              ...merged.deleted_thought_ids.map((id) => ({
                type: 'thought.deleted' as const,
                data: { id },
              })),
              ...merged.deleted_link_ids.map((id) => ({
                type: 'link.deleted' as const,
                data: { id },
              })),
            ],
            audit: {
              action: 'etn.layers.merge',
              targetType: 'layer',
              targetId: args.layer_id,
              details: { tables: args.tables, applied: report.applied },
            },
          };
        });
        return {
          applied: result.applied,
          skipped: result.skipped,
          reorder_collapsed: result.reorder_collapsed,
          reserve_layer_id: result.reserve_layer_id,
          purged: result.purged,
          activity_rollup: result.activity_rollup,
          request_id: String(extra.requestId),
        };
      }),
  );

  // =========================================================================
  // `etn.thoughts.bulk_update` (задача 6d45ab37, спека 77502d93, P1-паритет
  // MCP↔REST `POST /thoughts/batch`). Групповые операции над мыслями —
  // одна запись бюджета на ВЕСЬ вызов; `failures[]` для отдельных id.
}
