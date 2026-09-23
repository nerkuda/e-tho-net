/**
 * etn.guide + etn.ops — прогрессивное раскрытие редких операций MCP
 * (задача 86ef2ff4, версия 0.8.3).
 *
 * `etn.guide` — read-only витрина: без параметров отдаёт компактный реестр
 * «действие → когда нужно» (бюджет ≤ 10 КБ), с `topic` — полную инструкцию
 * вызова (состав `params`, обязательность `confirm`, эффекты, коды ошибок).
 * `etn.ops` — исполнитель: `action` + плоский `params` + `confirm: true` для
 * деструктивных. Перечень действий и схемы — в `ops-catalog.ts` (данные в
 * коде); обработчики — здесь, вызывают те же доменные сервисы, что и снятые
 * инструменты, без дублирования логики.
 *
 * Семантика каждой операции перенесена без изменений: те же доменные вызовы,
 * те же события/журнал/аудит, тот же write-бюджет и проверка прав. Имя
 * операции в `audit_log` остаётся прежним (`entry.tool`).
 *
 * Схемы обоих инструментов — плоские объекты без union (грабля 5498e16c);
 * `params` — свободный объект, валидация внутри по `action`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { BASE_LAYER_ID, EtnError, MCP_TOOL_ANNOTATIONS, TRAVERSAL_DEFAULTS, validateTypeRoles } from '@etn/shared';
import type { ExportFormat, LayerMergeReport, McpChangeEntry, McpMutationResult, Network } from '@etn/shared';

import { closeNetworkDb, openNetworkDb } from '../../db/network-db.js';
import { BRANCHABLE_TABLES } from '../../db/layer-chain.js';
import type { BranchableTable } from '../../db/layer-write.js';
import { mcpValidationError, Ops, Guide } from '../../contracts.js';
import type { OperationContract } from '../../contracts.js';
import {
  ActivityRollup,
  ActivityTruncate,
  AttachmentsAdd,
  AttachmentsCopy,
  AttachmentsDelete,
  AttachmentsSearch,
  AttachmentsUpdate,
  ChangesList,
  CommentsDelete,
  ExportSubgraph,
  ImportDryRun,
  ImportSubgraph,
  LayersCreate,
  LayersDelete,
  LayersDiff,
  LayersDiffDoc,
  LayersMerge,
  LayersUpdate,
  LocksAcquire,
  LocksClear,
  LocksList,
  LocksRelease,
  MembersList,
  MetricsReads,
  MetricsTools,
  NetworksDelete,
  NetworksWrite,
  PropertiesRemove,
  ThoughtsBacklinks,
  ThoughtsCopySubtree,
  ThoughtsDelete,
  ThoughtsDeletionCheck,
  ThoughtsMentions,
  ThoughtsMentionsScan,
  ThoughtsPath,
  ThoughtsUsageClear,
  TrashList,
  TrashPurge,
} from '../../contracts.js';
import {
  acquireLock,
  clearLocksForUser,
  listLocks,
  releaseLock,
} from '../../domain/lock-service.js';
import {
  copyAttachment,
  createAttachment,
  deleteAttachment,
  getAttachment,
  searchAttachments,
  updateAttachment,
} from '../../domain/attachment-service.js';
import { rollupActivity, truncateActivity } from '../../domain/activity-service.js';
import {
  createLayer,
  deleteLayerWithEvents,
  getLayerSnapshot,
  layerSubtreeIds,
  updateLayer,
} from '../../domain/layer-service.js';
import { layerDiffDoc, resolveDiffTarget, structuralLayerDiff } from '../../domain/layer-diff-service.js';
import { mergeLayer } from '../../domain/merge-service.js';
import type { MergeSelection } from '../../domain/merge-service.js';
import { findPath, subgraph } from '../../domain/graph-traversal.js';
import { getHomeThoughtId, getThoughtOrThrow, resolveThoughts, checkThoughtDeletion, deleteThought } from '../../domain/thought-service.js';
import { getLink } from '../../domain/link-service.js';
import { findMentions } from '../../domain/search-service.js';
import { findBacklinks } from '../../domain/backlinks-service.js';
import { deleteComment, getComment } from '../../domain/comment-service.js';
import { copySubtree as copySubtreeFn } from '../../domain/thought-subtree-copy-service.js';
import { importFromBuffer, planImportFromBuffer, readImportSource } from '../../domain/import-service-mcp.js';
import { listTrash, purgeTrash } from '../../domain/trash-service.js';
import { exportToMarkdown, getExportJobContent, startExportJob } from '../../domain/export-service.js';
import { clampReadMetricsParams, getColdReads, getTopReads } from '../../domain/read-metrics-service.js';
import { clearThoughtRefUsages, removeLinkPropertyValue } from '../../domain/property-service.js';
import { updateNetwork } from '../../domain/network-write-service.js';
import { resolveSessionLayer, resolveSessionSwitchSeq } from '../../domain/layer-service.js';
import { isEventVisibleInLayer } from '../../realtime/layer-visibility.js';
import { emitDomainEvent } from '../../realtime/emit.js';
import { projectLinkRow, projectThoughtRows } from '../../domain/response-projection.js';
import { thoughtTypeCatalog, withSanitizedIcon } from '../catalogs.js';
import type { AnyWriteEvent, WriteActivityEntry } from '../../domain/write-wrapper.js';
import {
  auditAgentCall,
  etnErrorText,
  mcpLayerClientId,
  mcpWriteFx,
  openMemberNetwork,
  openMemberNetworkBase,
  requireWritable,
  requireWriteBudget,
  resolveRuntimeLayer,
  runTool,
  runWrite,
  runWriteTool,
} from '../context.js';
import type { McpRuntime } from '../context.js';
import { executeMentionsScan } from './shared.js';
import { OPS_ACTIONS, OPS_ACTIONS_BY_NAME, OPS_ACTION_NAMES, type OpEntry } from './ops-catalog.js';

/** Разложить `params` по схеме действия (уже провалидированы контрактом). */
type Params = Record<string, unknown>;

/** Обработчик одного действия: получает runtime, проверенные `params` и extra вызова. */
type OpHandler = (
  rt: McpRuntime,
  params: Params,
  extra: { requestId?: string | number },
) => CallToolResult | Promise<CallToolResult>;

// ---------------------------------------------------------------------------
// Обработчики действий
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, OpHandler> = {
  // ---- locks ---------------------------------------------------------------
  'locks.acquire': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LocksAcquire.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const lock = runWrite(ndb, fx, () => {
        const acquired = acquireLock(ndb, {
          entityType: a.entity_type,
          entityId: a.entity_id,
          userId: rt.deps.auth.userId,
          clientId: null,
        });
        return {
          result: acquired,
          events: [
            {
              type: 'edit.acquired',
              data: {
                entity_type: acquired.entity_type,
                entity_id: acquired.entity_id,
                lock_id: acquired.id,
                user_id: acquired.user_id,
                client_id: acquired.client_id,
                acquired_at_ms: acquired.acquired_at_ms,
              },
            },
          ],
          audit: {
            action: 'etn.locks.acquire',
            targetType: acquired.entity_type,
            targetId: acquired.entity_id,
            details: { lock_id: acquired.id },
          },
        };
      });
      return { ...lock, request_id: String(extra.requestId) };
    });
  },
  'locks.release': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LocksRelease.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const released = runWrite(ndb, fx, () => {
        const dropped = releaseLock(ndb, a.lock_id, rt.deps.auth.userId);
        return {
          result: dropped,
          events: [
            {
              type: 'edit.released',
              data: {
                entity_type: dropped.entity_type,
                entity_id: dropped.entity_id,
                lock_id: dropped.id,
                user_id: dropped.user_id,
                client_id: dropped.client_id,
              },
            },
          ],
          audit: {
            action: 'etn.locks.release',
            targetType: dropped.entity_type,
            targetId: dropped.entity_id,
            details: { lock_id: dropped.id },
          },
        };
      });
      return { released: true as const, lock_id: released.id, request_id: String(extra.requestId) };
    });
  },
  'locks.clear': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LocksClear.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const removed = runWrite(ndb, fx, () => {
        const cleared = clearLocksForUser(ndb, a.user_id);
        return {
          result: cleared,
          events: cleared.map((lock) => ({
            type: 'edit.cleared' as const,
            data: {
              entity_type: lock.entity_type,
              entity_id: lock.entity_id,
              lock_id: lock.id,
              user_id: lock.user_id,
              client_id: lock.client_id,
              reason: 'manual' as const,
            },
          })),
          audit: {
            action: 'etn.locks.clear',
            targetType: 'network',
            targetId: a.network_id,
            details: { user_id: a.user_id, cleared: cleared.length },
          },
        };
      });
      return { cleared: removed.length, request_id: String(extra.requestId) };
    });
  },
  'locks.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof LocksList.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const locks = listLocks(ndb, {
        userId: a.user_id === undefined ? undefined : a.user_id,
        clientId: a.client_id === undefined ? undefined : a.client_id,
      });
      return { data: locks, meta: { total: locks.length, offset: 0, limit: locks.length } };
    });
  },

  // ---- attachments ---------------------------------------------------------
  'attachments.add': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof AttachmentsAdd.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const attachment = runWrite(ndb, fx, () => {
        const created = createAttachment(
          ndb,
          a.owner_type,
          a.owner_id,
          {
            kind: a.kind,
            url: a.url ?? null,
            file_path: a.file_path ?? null,
            title: a.title ?? null,
            description: a.description ?? null,
          },
          rt.deps.auth.userId,
        );
        return {
          result: created,
          events: [{ type: 'attachment.created', data: { attachment: created } }],
          activity: [{ kind: 'attachment', action: 'created', attachment: created }],
          audit: {
            action: 'etn.attachments.add',
            targetType: 'attachment',
            targetId: created.id,
            details: a,
          },
        };
      });
      return { id: attachment.id, version: 0, request_id: String(extra.requestId) } satisfies McpMutationResult;
    });
  },
  'attachments.copy': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof AttachmentsCopy.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const result = runWrite(ndb, fx, () => {
        const copied = copyAttachment(
          ndb,
          a.attachment_id,
          { target_owner_type: a.target_owner_type, target_owner_ids: a.target_owner_ids },
          rt.deps.auth.userId,
        );
        return {
          result: copied,
          events: copied.created.map((attachment) => ({
            type: 'attachment.created' as const,
            data: { attachment },
          })),
          activity: copied.created.map((attachment) => ({
            kind: 'attachment' as const,
            action: 'created' as const,
            attachment,
          })),
          audit: {
            action: 'etn.attachments.copy',
            targetType: 'attachment',
            targetId: a.attachment_id,
            details: a,
          },
        };
      });
      return result.created.map((att) => ({
        id: att.id,
        version: 0,
        request_id: String(extra.requestId),
      })) satisfies McpMutationResult[];
    });
  },
  'attachments.search': (rt, p) => {
    const a = p as unknown as z.infer<typeof AttachmentsSearch.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const { items } = searchAttachments(ndb, {
        q: a.q,
        kind: a.kind,
        exclude_owner_type: a.exclude_owner_type,
        exclude_owner_id: a.exclude_owner_id,
        limit: a.limit,
        offset: a.offset,
      });
      return items;
    });
  },
  'attachments.update': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof AttachmentsUpdate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const changes: {
        title?: string | null;
        description?: string | null;
        url?: string | null;
        file_path?: string | null;
      } = {};
      if (a.title !== undefined) changes.title = a.title;
      if (a.description !== undefined) changes.description = a.description;
      if (a.url !== undefined) changes.url = a.url;
      if (a.file_path !== undefined) changes.file_path = a.file_path;
      const attachment = runWrite(ndb, fx, () => {
        const updated = updateAttachment(ndb, a.attachment_id, changes, rt.deps.auth.userId);
        return {
          result: updated,
          events: [{ type: 'attachment.updated', data: { id: updated.id, changes } }],
          activity: [{ kind: 'attachment', action: 'updated', attachment: updated }],
          audit: {
            action: 'etn.attachments.update',
            targetType: 'attachment',
            targetId: updated.id,
            details: a,
          },
        };
      });
      return { id: attachment.id, version: 0, request_id: String(extra.requestId) } satisfies McpMutationResult;
    });
  },
  'attachments.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof AttachmentsDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      runWrite(ndb, fx, () => {
        const existing = getAttachment(ndb, a.attachment_id);
        deleteAttachment(ndb, a.attachment_id);
        return {
          result: undefined,
          events: [{ type: 'attachment.deleted', data: { id: a.attachment_id } }],
          ...(existing === null
            ? {}
            : {
                activity: [
                  { kind: 'attachment' as const, action: 'deleted' as const, attachment: existing },
                ],
              }),
          audit: {
            action: 'etn.attachments.delete',
            targetType: 'attachment',
            targetId: a.attachment_id,
            details: a,
          },
        };
      });
      return { deleted: true, request_id: String(extra.requestId) };
    });
  },

  // ---- activity ------------------------------------------------------------
  'activity.rollup': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ActivityRollup.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const result = runWrite(ndb, fx, () => {
        const rolled = rollupActivity(ndb, a.network_id, a.until_ms);
        return {
          result: rolled,
          audit: {
            action: 'etn.activity.rollup',
            targetType: 'network',
            targetId: a.network_id,
            details: { until_ms: a.until_ms, removed: rolled.removed, kept: rolled.kept },
          },
        };
      });
      return { ...result, request_id: String(extra.requestId) };
    });
  },
  'activity.truncate': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ActivityTruncate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const result = runWrite(ndb, fx, () => {
        const truncated = truncateActivity(ndb, a.network_id, a.until_ms);
        return {
          result: truncated,
          audit: {
            action: 'etn.activity.truncate',
            targetType: 'network',
            targetId: a.network_id,
            details: { until_ms: a.until_ms, removed: truncated.removed },
          },
        };
      });
      return { ...result, request_id: String(extra.requestId) };
    });
  },

  // ---- layers --------------------------------------------------------------
  'layers.create': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LayersCreate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const sessionLayer = resolveRuntimeLayer(rt, a.network_id);
      const parent = a.parent_id ?? sessionLayer.id;
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const layer = runWrite(ndb, fx, () => {
        const created = createLayer(ndb, {
          parentId: parent,
          title: a.title,
          comment: a.comment ?? null,
          gitBranch: a.git_branch ?? null,
          createdBy: rt.deps.auth.userId,
        });
        return {
          result: created,
          activity: [{ kind: 'layer', action: 'created', layer: created }],
          audit: {
            action: 'etn.layers.create',
            targetType: 'layer',
            targetId: created.id,
            details: { title: a.title, parent_id: parent },
          },
        };
      });
      return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
    });
  },
  'layers.update': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LayersUpdate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      if (a.title === undefined && a.comment === undefined) {
        throw new EtnError('VALIDATION_ERROR', 'нечего менять: передайте title и/или comment.', {
          fields: ['title', 'comment'],
        });
      }
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const sessionLayer = resolveRuntimeLayer(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const layer = runWrite(ndb, fx, () => {
        const updated = updateLayer(
          ndb,
          a.layer_id,
          {
            ...(a.title !== undefined ? { title: a.title } : {}),
            ...(a.comment !== undefined ? { comment: a.comment } : {}),
          },
          a.expected_version,
          rt.deps.auth.userId,
        );
        return {
          result: updated,
          activity: [{ kind: 'layer', action: 'updated', layer: updated }],
          audit: {
            action: 'etn.layers.update',
            targetType: 'layer',
            targetId: updated.id,
            details: { title: a.title, comment: a.comment },
          },
        };
      });
      return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
    });
  },
  'layers.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LayersDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const parentRow = getLayerSnapshot(ndb, a.layer_id);
      const subtreeIds = layerSubtreeIds(ndb, a.layer_id);
      for (const id of subtreeIds) {
        if (id !== BASE_LAYER_ID) closeNetworkDb(a.network_id, id);
      }
      const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(a.network_id) ?? 0;
      const fx = {
        ...mcpWriteFx(rt, a.network_id, extra.requestId),
        layerId: parentRow?.parent_id ?? BASE_LAYER_ID,
      };
      const result = runWrite(ndb, fx, () => {
        const res = deleteLayerWithEvents(ndb, a.layer_id, a.cascade, switchedAtSeq);
        return {
          result: res,
          events: [
            ...res.deleted_thought_ids.map((id) => ({ type: 'thought.deleted' as const, data: { id } })),
            ...res.deleted_link_ids.map((id) => ({ type: 'link.deleted' as const, data: { id } })),
          ],
          ...(parentRow === null
            ? {}
            : {
                activity: [
                  {
                    kind: 'layer' as const,
                    action: 'deleted' as const,
                    layer: { id: a.layer_id, title: parentRow.title },
                  },
                ],
              }),
          audit: {
            action: 'etn.layers.delete',
            targetType: 'layer',
            targetId: a.layer_id,
            details: { cascade: a.cascade, deleted: res.deleted },
          },
        };
      });
      return {
        deleted: result.deleted,
        purged: result.purged,
        skipped: result.skipped,
        request_id: String(extra.requestId),
      };
    });
  },
  'layers.diff': (rt, p) => {
    const a = p as unknown as z.infer<typeof LayersDiff.schema>;
    return runTool(() => {
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const { layer, target } = resolveDiffTarget(ndb, a.layer_id);
      const layerNdb = openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger, layer.id);
      const targetNdb = openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger, target.id);
      return structuralLayerDiff(layerNdb, targetNdb, layer, target);
    });
  },
  'layers.diff_doc': (rt, p) => {
    const a = p as unknown as z.infer<typeof LayersDiffDoc.schema>;
    return runTool(() => {
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const { layer, target } = resolveDiffTarget(ndb, a.layer_id);
      const layerNdb = openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger, layer.id);
      const targetNdb = openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger, target.id);
      return layerDiffDoc(layerNdb, targetNdb, layer, target);
    });
  },
  'layers.merge': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof LayersMerge.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      let selection: MergeSelection | undefined;
      if (a.tables !== undefined) {
        selection = {};
        for (const [table, ids] of Object.entries(a.tables)) {
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
      const ndb = openMemberNetworkBase(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const result = runWrite(ndb, fx, () => {
        const merged = mergeLayer(ndb, a.layer_id, selection, rt.deps.auth.userId);
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
            ...merged.deleted_thought_ids.map((id) => ({ type: 'thought.deleted' as const, data: { id } })),
            ...merged.deleted_link_ids.map((id) => ({ type: 'link.deleted' as const, data: { id } })),
          ],
          audit: {
            action: 'etn.layers.merge',
            targetType: 'layer',
            targetId: a.layer_id,
            details: { tables: a.tables, applied: report.applied },
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
    });
  },

  // ---- thoughts ------------------------------------------------------------
  'thoughts.path': (rt, p) => {
    const a = p as unknown as z.infer<typeof ThoughtsPath.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const path = findPath(ndb, a.from_id, a.to_id, a.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH, a.link_filter);
      const thoughts =
        path === null
          ? undefined
          : projectThoughtRows(resolveThoughts(ndb, path).map((t) => withSanitizedIcon(t)));
      return {
        from_id: a.from_id,
        to_id: a.to_id,
        path,
        ...(thoughts === undefined
          ? {}
          : {
              thoughts,
              thought_types: thoughtTypeCatalog(ndb, thoughts.map((t) => t.type_id)),
            }),
      };
    });
  },
  'thoughts.mentions': (rt, p) => {
    const a = p as unknown as z.infer<typeof ThoughtsMentions.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return findMentions(ndb, a.thought_id);
    });
  },
  'thoughts.backlinks': (rt, p) => {
    const a = p as unknown as z.infer<typeof ThoughtsBacklinks.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return findBacklinks(ndb, a.thought_id);
    });
  },
  'thoughts.mentions_scan': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ThoughtsMentionsScan.schema>;
    if (a.create_links === true) {
      return runWriteTool(rt, a.network_id, () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, a.network_id);
        const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
        const result = runWrite(ndb, fx, () => {
          const scanned = executeMentionsScan(ndb, a, rt.deps.auth.userId);
          return {
            result: scanned,
            audit: {
              action: 'etn.thoughts.mentions_scan',
              targetType: 'network',
              targetId: a.network_id,
              details: { matches: scanned.matches.length, links_created: scanned.links_created },
            },
          };
        });
        return { matches: result.matches, links_created: result.links_created, request_id: String(extra.requestId) };
      });
    }
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const result = executeMentionsScan(ndb, a, rt.deps.auth.userId);
      return { matches: result.matches, links_created: result.links_created, request_id: String(extra.requestId) };
    });
  },
  'thoughts.copy_subtree': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ThoughtsCopySubtree.schema>;
    return runWriteTool(rt, a.target_network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const sourceNdb = openNetworkDb(rt.deps.dataDir, a.source_network_id);
      const targetNdb = openMemberNetwork(rt, a.target_network_id);
      const fx = mcpWriteFx(rt, a.target_network_id, extra.requestId);
      const parentId = a.target_parent_thought_id ?? '';
      const summary = runWrite(targetNdb, fx, () => {
        const copied = copySubtreeFn({
          source_ndb: sourceNdb,
          target_ndb: targetNdb,
          root_thought_ids: a.root_thought_ids,
          max_depth: a.max_depth ?? 5,
          include: a.include ?? ['thought', 'links', 'properties', 'comments', 'attachments'],
          duplicate_policy: a.duplicate_policy ?? 'fail',
          target_parent_thought_id: parentId,
          actor_user_id: rt.deps.auth.userId,
        });
        const events: AnyWriteEvent[] = [];
        const activity: WriteActivityEntry[] = [];
        for (const [, newId] of Object.entries(copied.thought_id_map)) {
          if (newId === '') continue;
          const thought = getThoughtOrThrow(targetNdb, newId);
          events.push({ type: 'thought.created', data: { thought } });
          activity.push({ kind: 'thought', action: 'created', thought });
        }
        for (const [, newId] of Object.entries(copied.link_id_map)) {
          if (newId === '') continue;
          const link = getLink(targetNdb, newId);
          if (link !== null) {
            events.push({ type: 'link.created', data: { link } });
            activity.push({ kind: 'link', action: 'created', link });
          }
        }
        return {
          result: copied,
          events,
          activity,
          audit: {
            action: 'etn.thoughts.copy_subtree',
            targetType: 'network',
            targetId: a.target_network_id,
            details: {
              thoughts_created: copied.thoughts_created,
              thoughts_reused: copied.thoughts_reused,
              thoughts_skipped: copied.thoughts_skipped,
              links_created: copied.links_created,
            },
          },
        };
      });
      const layer = resolveRuntimeLayer(rt, a.target_network_id);
      const includeRemap = a.id_remap !== false;
      return {
        thoughts_created: summary.thoughts_created,
        thoughts_reused: summary.thoughts_reused,
        thoughts_skipped: summary.thoughts_skipped,
        links_created: summary.links_created,
        ...(includeRemap ? { thought_id_map: summary.thought_id_map } : {}),
        ...(includeRemap ? { link_id_map: summary.link_id_map } : {}),
        conflicts: summary.conflicts,
        layer: { id: layer.id, title: layer.title },
        request_id: String(extra.requestId),
      };
    });
  },
  'thoughts.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ThoughtsDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      runWrite(ndb, fx, () => {
        const existing = getThoughtOrThrow(ndb, a.thought_id);
        deleteThought(ndb, a.thought_id, a.expected_version, rt.deps.auth.userId);
        return {
          result: undefined,
          events: [{ type: 'thought.deleted', data: { id: a.thought_id } }],
          activity: [{ kind: 'thought', action: 'deleted', thought: existing }],
          audit: {
            action: 'etn.thoughts.delete',
            targetType: 'thought',
            targetId: a.thought_id,
            details: { expected_version: a.expected_version },
          },
        };
      });
      return { id: a.thought_id, version: 0, request_id: String(extra.requestId) } satisfies McpMutationResult;
    });
  },
  'thoughts.deletion_check': (rt, p) => {
    const a = p as unknown as z.infer<typeof ThoughtsDeletionCheck.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const result: Record<string, unknown> = {};
      for (const id of [...new Set(a.thought_ids)]) {
        result[id] = checkThoughtDeletion(ndb, id);
      }
      return result;
    });
  },
  'usage_clear': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ThoughtsUsageClear.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const cleared = runWrite(ndb, fx, () => {
        getThoughtOrThrow(ndb, a.thought_id);
        const result = clearThoughtRefUsages(ndb, a.thought_id);
        return {
          result,
          audit: {
            action: 'etn.thoughts.usage_clear',
            targetType: 'thought',
            targetId: a.thought_id,
            details: { cleared: result },
          },
        };
      });
      return { cleared, request_id: String(extra.requestId) };
    });
  },

  // ---- trash ---------------------------------------------------------------
  'trash.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof TrashList.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const trash = listTrash(ndb);
      return {
        thoughts: projectThoughtRows(trash.thoughts.map((t) => withSanitizedIcon(t))),
        links: trash.links.map((l) => projectLinkRow(l)),
      };
    });
  },
  'trash.purge': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof TrashPurge.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const { purged, skipped } = runWrite(ndb, fx, () => {
        const swept = purgeTrash(ndb);
        return {
          ...swept,
          audit: {
            action: 'etn.trash.purge',
            targetType: 'network',
            targetId: a.network_id,
            details: { purged: swept.result.purged, skipped: swept.result.skipped },
          },
        };
      });
      return {
        purged,
        skipped,
        ...(skipped > 0 ? { how_to: 'etn.how_to_purge' } : {}),
        request_id: String(extra.requestId),
      };
    });
  },

  // ---- export / import -----------------------------------------------------
  'export.subgraph': (rt, p) => {
    const a = p as unknown as z.infer<typeof ExportSubgraph.schema>;
    return runTool(async () => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const format: ExportFormat = a.format ?? 'markdown';
      const result = subgraph(ndb, a.seed_ids, a.radius, { maxNodes: rt.limits.maxNodesPerSubgraph });
      if (format === 'markdown') {
        return { format, truncated: result.truncated, content: exportToMarkdown(ndb, result.nodes) };
      }
      if (format === 'etnx') {
        const job = await startExportJob(ndb, result.nodes, format, {
          etnx: a.etnx_options ?? {},
          source: { network_id: a.network_id, network_name: a.network_id, user_id: rt.deps.auth.userId },
        });
        const downloaded = getExportJobContent(job.job_id, format);
        if (downloaded === null) throw new Error('ETN error [INTERNAL]: export content unavailable');
        if (typeof downloaded.body === 'string') {
          throw new Error('ETN error [INTERNAL]: expected binary export content, got string');
        }
        return {
          format,
          truncated: result.truncated,
          content_b64: downloaded.body.toString('base64'),
          size: downloaded.body.length,
        };
      }
      const job = await startExportJob(ndb, result.nodes, format, {
        source: { network_id: a.network_id, network_name: a.network_id, user_id: rt.deps.auth.userId },
      });
      const downloaded = getExportJobContent(job.job_id, format);
      if (downloaded === null) throw new Error('ETN error [INTERNAL]: export content unavailable');
      if (typeof downloaded.body !== 'string') {
        throw new Error('ETN error [INTERNAL]: expected textual export content, got binary');
      }
      return { format, truncated: result.truncated, content: downloaded.body };
    });
  },
  'import.dry_run': (rt, p) => {
    const a = p as unknown as z.infer<typeof ImportDryRun.schema>;
    return runTool(async () => {
      const ndb = openMemberNetwork(rt, a.network_id);
      const buf = readImportSource(a.source);
      const plan = await planImportFromBuffer(ndb, buf, a.collision_policy, rt.deps.logger);
      return {
        ok: true as const,
        manifest_version: plan.manifest_version,
        source_network_name: plan.source_network_name,
        plan: plan.plan,
        conflicts: plan.conflicts,
      };
    });
  },
  'import.subgraph': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof ImportSubgraph.schema>;
    return runWriteTool(rt, a.network_id, async () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const buf = readImportSource(a.source);
      const ndb = openMemberNetwork(rt, a.network_id);
      let parentId = a.parent_thought_id;
      if (parentId === undefined) {
        const homeId = getHomeThoughtId(ndb);
        if (homeId === null) throw new Error('ETN error [INTERNAL]: target network has no HOME thought');
        parentId = homeId;
      }
      const result = await importFromBuffer(
        ndb,
        buf,
        { actorUserId: rt.deps.auth.userId, parentThoughtId: parentId },
        rt.deps.logger,
        a.collision_policy,
      );
      runWrite(ndb, mcpWriteFx(rt, a.network_id, extra.requestId), () => {
        const events: AnyWriteEvent[] = [];
        const activity: WriteActivityEntry[] = [];
        for (const id of result.createdThoughtIds) {
          const thought = getThoughtOrThrow(ndb, id);
          events.push({ type: 'thought.created', data: { thought } });
          activity.push({ kind: 'thought', action: 'created', thought });
        }
        for (const id of result.createdLinkIds) {
          const link = getLink(ndb, id);
          if (link !== null) {
            events.push({ type: 'link.created', data: { link } });
            activity.push({ kind: 'link', action: 'created', link });
          }
        }
        return {
          result: undefined,
          events,
          activity,
          audit: {
            action: 'etn.import.subgraph',
            targetType: 'network',
            targetId: a.network_id,
            details: {
              thoughts_created: result.thoughts_created,
              thoughts_updated: result.thoughts_updated,
              thoughts_reused: result.thoughts_reused,
              links_created: result.links_created,
              attachments_imported: result.attachments_imported,
            },
          },
        };
      });
      const layer = resolveRuntimeLayer(rt, a.network_id);
      return {
        imported: {
          thoughts_created: result.thoughts_created,
          thoughts_updated: result.thoughts_updated,
          thoughts_reused: result.thoughts_reused,
          thoughts_skipped: result.thoughts_skipped ?? 0,
          links_created: result.links_created,
          permanent_comments_updated: result.permanent_comments_updated,
          chronological_comments_added: result.chronological_comments_added,
          property_values_set: result.property_values_set,
          attachments_imported: result.attachments_imported,
          thought_types_created: result.thought_types_created,
          thought_types_reused: result.thought_types_reused,
          link_types_created: result.link_types_created,
          link_types_reused: result.link_types_reused,
        },
        conflicts: [],
        manifest_version: result.manifest_version,
        layer: { id: layer.id, title: layer.title },
        request_id: String(extra.requestId),
      };
    });
  },

  // ---- metrics -------------------------------------------------------------
  'metrics.reads': (rt, p) => {
    const a = p as unknown as z.infer<typeof MetricsReads.schema>;
    return runTool(() => {
      const network = rt.deps.systemDb.getNetworkById(a.network_id);
      if (network === null) throw new EtnError('NOT_FOUND', `Network ${a.network_id} not found.`);
      assertAccess(rt, a.network_id);
      const { kind, limit } = clampReadMetricsParams({ kind: a.kind, limit: a.limit });
      const includeInactive = a.include_inactive === true;
      const since = kind === 'cold' ? a.since : undefined;
      const ndb = openMemberNetwork(rt, a.network_id);
      const items =
        kind === 'cold'
          ? getColdReads(ndb, { limit, since, includeInactive })
          : getTopReads(ndb, { limit, includeInactive });
      return {
        network_id: a.network_id,
        kind,
        since: since ?? null,
        limit,
        items,
        thought_types: thoughtTypeCatalog(ndb, items.map((i) => i.type_id)),
      };
    });
  },
  'metrics.tools': (rt, p) => {
    const a = p as unknown as z.infer<typeof MetricsTools.schema>;
    return runTool(() => {
      if (a.network_id !== undefined) assertAccess(rt, a.network_id);
      const groupBy = a.group_by ?? 'tool';
      const limit = Math.min(Math.max(a.limit ?? 50, 1), 200);
      const isAdmin = rt.deps.auth.isAdmin;
      const items = rt.deps.systemDb.aggregateToolCallMetrics({
        groupBy,
        networkId: a.network_id,
        fromMs: a.from_ms,
        toMs: a.to_ms,
        limit,
        visibleNetworks: isAdmin ? null : rt.deps.systemDb.listMemberNetworkIds(rt.deps.auth.userId),
        visibleKeyIds: isAdmin ? [] : rt.deps.systemDb.listApiKeyIdsByUser(rt.deps.auth.userId),
      });
      return { group_by: groupBy, limit, items };
    });
  },

  // ---- networks / members / changes ---------------------------------------
  'networks.list': (rt) =>
    runTool(() => rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId)),
  'networks.write': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof NetworksWrite.schema>;
    const op = async (): Promise<unknown> => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const requestedRoles = a.type_roles !== undefined ? validateTypeRoles(a.type_roles) : undefined;
      let network: Network;
      if (a.network_id === undefined) {
        const displayName = (a.display_name ?? '').trim();
        if (displayName.length === 0) {
          throw new EtnError('VALIDATION_ERROR', 'display_name обязательно при создании сети.', {
            field: 'display_name',
          });
        }
        const description =
          a.description === undefined || a.description === '' ? null : a.description;
        for (const [role, value] of Object.entries(requestedRoles ?? {}) as Array<[string, string | null]>) {
          if (value !== null) {
            throw new EtnError(
              'VALIDATION_ERROR',
              `На создании сети нельзя указывать непустую роль type_roles.${role}: в новой сети ещё нет типов.`,
              { field: `type_roles.${role}`, value },
            );
          }
        }
        network = await rt.deps.networkService.createNetwork(
          rt.deps.auth.userId,
          displayName,
          description,
          requestedRoles ?? {},
        );
        rt.deps.systemDb.insertAuditLog({
          actorUserId: rt.deps.auth.userId,
          networkId: network.id,
          category: 'network',
          action: 'network.create',
          targetType: 'network',
          targetId: network.id,
          details: { display_name: displayName, type_roles: requestedRoles ?? {}, via: 'mcp.etn.ops' },
        });
      } else {
        const networkId = a.network_id;
        const existing = rt.deps.systemDb.getNetworkById(networkId);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `Сеть ${networkId} не найдена.`, { network_id: networkId });
        }
        const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId);
        if (!rt.deps.auth.isAdmin && role !== 'owner') {
          throw new EtnError('FORBIDDEN', 'Требуются права владельца сети или администратора.', {
            network_id: networkId,
          });
        }
        const { network: updated, changes } = updateNetwork(
          rt.deps.systemDb,
          rt.deps.networkService,
          existing,
          {
            ...(a.display_name !== undefined ? { display_name: a.display_name } : {}),
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.when_to_use !== undefined ? { when_to_use: a.when_to_use } : {}),
            ...(a.conventions !== undefined ? { conventions: a.conventions } : {}),
            ...(a.examples !== undefined ? { examples: a.examples } : {}),
            ...(requestedRoles !== undefined ? { type_roles: requestedRoles } : {}),
          },
          { userId: rt.deps.auth.userId, via: 'mcp.etn.ops' },
        );
        if (Object.keys(changes).length > 0) {
          emitDomainEvent(
            { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
            networkId,
            'network.updated',
            changes,
            { user_id: rt.deps.auth.userId, client_id: rt.deps.auth.keyId },
            { meta: { request_id: String(extra.requestId) } },
          );
        }
        network = updated;
      }
      auditAgentCall(rt, 'etn.networks.write', network.id, 'network', network.id, {
        created: a.network_id === undefined,
        type_roles_keys: Object.keys(requestedRoles ?? {}),
      });
      return {
        id: network.id,
        display_name: network.display_name,
        owner_id: network.owner_id,
        description: network.description,
        when_to_use: network.when_to_use,
        conventions: network.conventions,
        examples: network.examples,
        type_roles: network.type_roles,
        has_structure: typeof network.type_roles.table_of_contents === 'string',
        created_at: network.created_at,
        updated_at: network.updated_at,
        request_id: String(extra.requestId),
      };
    };
    return a.network_id === undefined
      ? runTool(op)
      : runWriteTool(rt, a.network_id, op);
  },
  'networks.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof NetworksDelete.schema>;
    return runTool(async () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      if (!rt.deps.auth.isAdmin) {
        throw new EtnError('FORBIDDEN', 'Удаление сети доступно только администратору сервера.', {
          network_id: a.network_id,
        });
      }
      const existing = rt.deps.systemDb.getNetworkById(a.network_id);
      if (existing === null) {
        throw new EtnError('NOT_FOUND', `Сеть ${a.network_id} не найдена.`, { network_id: a.network_id });
      }
      emitDomainEvent(
        { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
        a.network_id,
        'network.deleted',
        { id: a.network_id },
        { user_id: rt.deps.auth.userId, client_id: rt.deps.auth.keyId },
        { meta: { request_id: String(extra.requestId) } },
      );
      await rt.deps.networkService.deleteNetwork(a.network_id);
      rt.deps.systemDb.insertAuditLog({
        actorUserId: rt.deps.auth.userId,
        networkId: a.network_id,
        category: 'network',
        action: 'delete',
        targetType: 'network',
        targetId: a.network_id,
        details: { by_admin: true, via: 'mcp.etn.ops' },
      });
      auditAgentCall(rt, 'etn.networks.delete', a.network_id, 'network', a.network_id, { confirm: true });
      return { deleted: true, network_id: a.network_id, request_id: String(extra.requestId) };
    });
  },
  'members.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof MembersList.schema>;
    return runTool(() => {
      openMemberNetwork(rt, a.network_id);
      const rows = rt.deps.systemDb.listNetworkMembers(a.network_id);
      return {
        members: rows.map((r) => ({
          user_id: r.user_id,
          display_name: r.display_name,
          role: r.role,
          joined_at: r.added_at,
        })),
      };
    });
  },
  'changes.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof ChangesList.schema>;
    return runTool(() => {
      const network = rt.deps.systemDb.getNetworkById(a.network_id);
      if (network === null) throw new EtnError('NOT_FOUND', `Network ${a.network_id} not found.`);
      assertAccess(rt, a.network_id);
      const limit = a.limit ?? 1000;
      const minSeq = rt.deps.systemDb.getMinEventSeq(a.network_id);
      const maxSeq = rt.deps.systemDb.getMaxEventSeq(a.network_id);
      const events = rt.deps.systemDb.readEventsAfter(a.network_id, a.since_seq, limit);
      const authUserId = rt.deps.auth.userId;
      const baseNdb = openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger);
      const clientId = mcpLayerClientId(rt);
      const sessionLayer = resolveSessionLayer(baseNdb, authUserId, clientId);
      const switchedAtSeq = resolveSessionSwitchSeq(baseNdb, authUserId, clientId);
      const layerNdb =
        sessionLayer.id === baseNdb.layerId
          ? baseNdb
          : openNetworkDb(rt.deps.dataDir, a.network_id, rt.deps.logger, sessionLayer.id);
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
      const truncated =
        a.since_seq !== 0 &&
        ((minSeq !== null && a.since_seq < minSeq - 1) || (switchedAtSeq > 0 && a.since_seq < switchedAtSeq));
      return {
        network_id: a.network_id,
        cursor: { min_seq: minSeq, max_seq: maxSeq },
        events: filtered,
        truncated,
        limit,
      };
    });
  },

  // ---- comments / properties ----------------------------------------------
  'comments.delete': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof CommentsDelete.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      runWrite(ndb, fx, () => {
        const existing = getComment(ndb, a.comment_id);
        if (existing === null) {
          throw new Error(`ETN error [NOT_FOUND]: comment ${a.comment_id} not found`);
        }
        deleteComment(ndb, a.comment_id, a.expected_version);
        return {
          result: undefined,
          events: [
            {
              type: 'comment.deleted',
              data: { owner_type: existing.owner_type, owner_id: existing.owner_id, id: a.comment_id },
            },
          ],
          activity: [{ kind: 'comment', action: 'deleted', comment: existing }],
          audit: {
            action: 'etn.comments.delete',
            targetType: 'comment',
            targetId: a.comment_id,
            details: { expected_version: a.expected_version },
          },
        };
      });
      return { id: a.comment_id, version: 0, request_id: String(extra.requestId) } satisfies McpMutationResult;
    });
  },
  'properties.remove': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof PropertiesRemove.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const res = runWrite(ndb, fx, () => {
        const result = removeLinkPropertyValue(
          ndb,
          a.owner_type,
          a.owner_id,
          a.key,
          a.value,
          rt.deps.auth.userId,
        );
        const marked = result.link_id !== null ? getLink(ndb, result.link_id) : null;
        return {
          result,
          ...(marked === null
            ? {}
            : {
                events: [
                  {
                    type: 'link.updated' as const,
                    data: {
                      id: marked.id,
                      changes: { marked_for_deletion: true },
                      version: marked.version,
                    },
                  },
                ],
                activity: [{ kind: 'link' as const, action: 'trashed' as const, link: marked }],
              }),
          audit: {
            action: 'etn.properties.remove',
            targetType: a.owner_type,
            targetId: a.owner_id,
            details: { key: a.key, value: a.value },
          },
        };
      });
      return { link_id: res.link_id, request_id: String(extra.requestId) };
    });
  },
};

/** Проверка доступа к сети для read-действий (форwards на общий хелпер). */
function assertAccess(rt: McpRuntime, networkId: string): void {
  if (rt.deps.auth.isAdmin) return;
  if (rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId) === null) {
    throw new EtnError('FORBIDDEN', `You are not a member of network ${networkId}; this API key cannot access it.`, {
      network_id: networkId,
    });
  }
}

// ---------------------------------------------------------------------------
// Регистрация инструментов
// ---------------------------------------------------------------------------

/** Текст реестра «действие → когда нужно» (бюджет ≤ 10 КБ). */
function renderRegistry(): string {
  const groups: { group: string; entries: OpEntry[] }[] = [];
  for (const entry of OPS_ACTIONS) {
    const bucket = groups.find((g) => g.group === entry.group);
    if (bucket === undefined) groups.push({ group: entry.group, entries: [entry] });
    else bucket.entries.push(entry);
  }
  const lines: string[] = [
    '# Редкие операции MCP (etn.ops)',
    '',
    'Вызов: `etn.ops { action, params, confirm: true }` — `confirm` обязателен для деструктивных.',
    'Полная инструкция по действию: `etn.guide { topic: "<action>" }`.',
    '',
  ];
  for (const { group, entries } of groups) {
    lines.push(`## ${group}`);
    for (const entry of entries) {
      const flag = entry.destructive ? ' (confirm)' : entry.readOnly ? ' (read-only)' : '';
      lines.push(`- **${entry.action}**${flag} — ${entry.when}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Текст полной инструкции по действию. */
function renderTopic(entry: OpEntry): string {
  const lines: string[] = [
    `# ${entry.action}`,
    '',
    entry.when,
    '',
    `Группа: ${entry.group}. Инструмент до слияния: \`${entry.tool}\`.`,
    `Деструктивна: ${entry.destructive ? 'да — требуется `confirm: true` на верхнем уровне `etn.ops`' : 'нет'}.`,
    `Read-only: ${entry.readOnly ? 'да' : 'нет'}.`,
    '',
    '## params',
  ];
  if (entry.params.length === 0) {
    lines.push('Параметров нет.');
  } else {
    for (const param of entry.params) {
      lines.push(`- \`${param.name}\`${param.required === true ? ' (обязателен)' : ''} — ${param.desc}`);
    }
  }
  lines.push('', '## Эффекты', entry.effects, '', '## Ошибки', entry.errors, '');
  lines.push('## Пример');
  const exampleParams = entry.params.reduce<Record<string, string>>((acc, param) => {
    if (param.required === true) acc[param.name] = '<значение>';
    return acc;
  }, {});
  lines.push(
    '```json',
    JSON.stringify(
      {
        action: entry.action,
        params: exampleParams,
        ...(entry.destructive ? { confirm: true } : {}),
      },
      null,
      2,
    ),
    '```',
  );
  return lines.join('\n');
}

/** Зарегистрировать `etn.guide` и `etn.ops`. */
export function registerGuideTools(mcp: McpServer, rt: McpRuntime): void {
  mcp.registerTool(
    'etn.guide',
    {
      title: 'Справочник редких операций',
      description:
        'Read-only витрина редких операций MCP (прогрессивное раскрытие, ADR b2eebf8b). Без ' +
        'параметров — реестр «действие → когда нужно» (одна строка на действие). С `topic` — ' +
        'полная инструкция вызова: состав `params`, обязательность `confirm`, эффекты, коды ' +
        'ошибок. Исполнитель — `etn.ops`; не вызывай его мимо гайда.',
      inputSchema: Guide.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.guide'],
    },
    async (args) => {
      try {
        if (args.topic === undefined) {
          return { content: [{ type: 'text', text: renderRegistry() }] };
        }
        const entry = OPS_ACTIONS_BY_NAME.get(args.topic);
        if (entry === undefined) {
          throw new EtnError('VALIDATION_ERROR', `Неизвестное действие «${args.topic}».`, {
            field: 'topic',
            allowed: OPS_ACTION_NAMES,
          });
        }
        return { content: [{ type: 'text', text: renderTopic(entry) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: etnErrorText(err) }], isError: true };
      }
    },
  );

  mcp.registerTool(
    'etn.ops',
    {
      title: 'Исполнитель редких операций',
      description:
        'Исполнитель редких (низкочастотных) операций, снятых из постоянного набора ' +
        '(прогрессивное раскрытие, ADR b2eebf8b). `action` — имя из справочника `etn.guide`; ' +
        '`params` — плоский объект, состав по инструкции гайда; `confirm: true` — обязателен ' +
        'для деструктивных (delete/purge/truncate/import/layers.delete/merge), без него ' +
        'VALIDATION_ERROR. Сначала прочитай `etn.guide { topic }` — там состав params и ' +
        'эффекты. Семантика каждой операции перенесена без изменений.',
      inputSchema: Ops.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ops'],
    },
    async (args, extra) => {
      try {
        const entry = OPS_ACTIONS_BY_NAME.get(args.action);
        if (entry === undefined) {
          throw new EtnError('VALIDATION_ERROR', `Неизвестное действие «${args.action}». Список — в etn.guide.`, {
            field: 'action',
            allowed: OPS_ACTION_NAMES,
          });
        }
        if (entry.destructive && args.confirm !== true) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `Действие «${entry.action}» деструктивно: требуется confirm: true.`,
            { field: 'confirm' },
          );
        }
        const params = args.params ?? {};
        const verr = mcpValidationError(entry.paramsContract as OperationContract, params);
        if (verr !== null) throw verr;
        const handler = HANDLERS[entry.action];
        if (handler === undefined) {
          throw new EtnError('INTERNAL', `Нет обработчика для действия «${entry.action}».`);
        }
        return await handler(rt, params, extra as { requestId?: string | number });
      } catch (err) {
        return { content: [{ type: 'text', text: etnErrorText(err) }], isError: true };
      }
    },
  );
}
